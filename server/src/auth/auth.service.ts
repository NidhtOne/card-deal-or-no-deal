import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

/** HTTP 423 Locked（NestJS HttpStatus 枚举未收录该状态码） */
const HTTP_LOCKED = 423;
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { parseDbDate } from '../common/db-date';
import { isUniqueViolation } from '../common/db-error';
import { runInTransaction } from '../common/transaction';
import { getEconomyConfig } from '../config/economy';
import { FundFlowType } from '../entities/fund-flow.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserProfile } from '../entities/user-profile.entity';
import { UserSettings } from '../entities/user-settings.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { User, USER_STATUS } from '../entities/user.entity';
import { WalletService } from '../wallet/wallet.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';

/** 登录安全参数（3.1.2） */
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
/** Refresh 有效期：默认 14 天（3.1.2）；「记住我」延长至 30 天（文档未定义具体值，决策为 30 天） */
const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const REMEMBER_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  user: { id: number; username: string };
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 密保答案归一化：去首尾空白并转小写，降低找回时的记忆负担 */
function normalizeSecurityAnswer(answer: string): string {
  return answer.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
    private readonly jwtService: JwtService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * 注册（3.1.1 / 6.1）：单事务内建 users + user_profiles + user_wallets + user_settings，
   * 并按 config/economy.json 的 initial_funds 发放初始赠送（写 fund_flows，幂等键 register:{userId}）。
   * 用户名并发重复由 UNIQUE 约束兜底返回 409。成功后自动登录（直接发双令牌）。
   */
  async register(dto: RegisterDto): Promise<TokenBundle> {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('两次输入的密码不一致');
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const securityAnswerHash = await bcrypt.hash(normalizeSecurityAnswer(dto.securityAnswer), 10);
    const initialFundsFen = getEconomyConfig().initialFundsFen;

    // 写事务走全局 FIFO 互斥入口（M2 起钦定：避免 better-sqlite3 并发事务嵌套 SAVEPOINT）
    const user = await runInTransaction(this.dataSource, async (manager: EntityManager) => {
      let saved: User;
      try {
        saved = await manager.save(
          User,
          manager.create(User, {
            username: dto.username,
            passwordHash,
            securityQuestion: dto.securityQuestion,
            securityAnswerHash,
          }),
        );
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException('用户名已被占用');
        throw e;
      }
      await manager.save(
        UserProfile,
        manager.create(UserProfile, { userId: saved.id, nickname: saved.username }),
      );
      await manager.save(UserWallet, manager.create(UserWallet, { userId: saved.id, balance: 0 }));
      // 默认值见实体注解（3.7）：BGM 开/默认曲目/60、音效开/80、面额清单开、风险提示开、成就开
      await manager.save(UserSettings, manager.create(UserSettings, { userId: saved.id }));
      // 铁律 1/2：初始赠送走统一资金原语，同事务写 fund_flows（type=初始赠送）
      await this.walletService.adjustBalance(manager, {
        userId: saved.id,
        delta: initialFundsFen,
        type: FundFlowType.Initial,
        idemKey: `register:${saved.id}`,
      });
      return saved;
    });

    return this.issueTokens(user, false);
  }

  /** 用户名唯一性实时校验（3.1.1；6.1 未定义 —— 文档外补充） */
  async checkUsername(username: string): Promise<{ available: boolean }> {
    if (!/^[A-Za-z0-9_]{4,16}$/.test(username)) return { available: false };
    const exists = await this.users.exist({ where: { username } });
    return { available: !exists };
  }

  /**
   * 登录（3.1.2 / 6.1）：
   * - 锁定判定先于密码校验，锁定期间返回剩余锁定秒数（HTTP 423）；
   * - 连续失败 5 次锁定 15 分钟（失败计数与 locked_until 落库，成功清零）；
   * - 已注销账号拒绝登录；成功后更新 last_login_at。
   */
  async login(dto: LoginDto): Promise<TokenBundle> {
    const user = await this.users.findOne({ where: { username: dto.username } });
    if (!user || user.status !== USER_STATUS.NORMAL) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    // 锁定判定先于密码校验
    const lockedUntil = parseDbDate(user.lockedUntil);
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw this.lockedException(lockedUntil);
    }

    // 文档外补充决策（3.1.2 只定义「连续失败 5 次锁定 15 分钟」，未定义解锁后的计数语义）：
    // locked_until 到期后 failed_login_attempts 重置为 0，恢复完整 5 次失败机会，
    // 而不是「解锁后仅剩 1 次试错即再锁」。
    let failedAttempts = user.failedLoginAttempts;
    if (lockedUntil) {
      failedAttempts = 0;
      await this.users.update({ id: user.id }, { failedLoginAttempts: 0, lockedUntil: null });
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      const attempts = failedAttempts + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        const until = new Date(Date.now() + LOCK_DURATION_MS);
        await this.users.update(
          { id: user.id },
          { failedLoginAttempts: attempts, lockedUntil: until },
        );
        throw this.lockedException(until);
      }
      await this.users.update({ id: user.id }, { failedLoginAttempts: attempts });
      throw new UnauthorizedException('用户名或密码错误');
    }

    await this.users.update(
      { id: user.id },
      { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    );
    return this.issueTokens(user, dto.rememberMe ?? false);
  }

  /** 锁定响应：HTTP 423 + 剩余锁定秒数 */
  private lockedException(until: Date): HttpException {
    const lockedSeconds = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
    return new HttpException(
      { message: '连续失败次数过多，账号已锁定，请稍后再试', lockedSeconds },
      HTTP_LOCKED,
    );
  }

  /**
   * Refresh 轮换（6.1）：旧 Refresh 立即吊销，重放旧 Token 返回 401。
   * 新令牌有效期沿用原令牌 TTL（保留「记住我」差异）。
   */
  async refresh(refreshToken: string): Promise<TokenBundle> {
    const tokenHash = hashRefreshToken(refreshToken);
    const row = await this.refreshTokens.findOne({ where: { tokenHash } });
    const expiresAt = row ? parseDbDate(row.expiresAt) : null;
    if (!row || row.revokedAt !== null || !expiresAt || expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh Token 无效或已过期');
    }
    const user = await this.users.findOne({ where: { id: row.userId } });
    if (!user || user.status !== USER_STATUS.NORMAL) {
      throw new UnauthorizedException('账号不存在或已注销');
    }

    const createdAt = parseDbDate(row.createdAt) ?? new Date();
    const ttlMs = Math.max(expiresAt.getTime() - createdAt.getTime(), 60 * 1000);
    const accessToken = await this.jwtService.signAsync({ sub: user.id, username: user.username });
    const newRefreshToken = randomBytes(48).toString('hex');
    // 轮换：吊销旧令牌 + 签发新令牌，同事务保证一致性
    // （写事务走全局 FIFO 互斥入口，见 common/transaction.ts）
    await runInTransaction(this.dataSource, async (manager) => {
      await manager.update(RefreshToken, { id: row.id }, { revokedAt: new Date() });
      await manager.save(
        RefreshToken,
        manager.create(RefreshToken, {
          userId: user.id,
          tokenHash: hashRefreshToken(newRefreshToken),
          expiresAt: new Date(Date.now() + ttlMs),
        }),
      );
    });
    return {
      accessToken,
      refreshToken: newRefreshToken,
      user: { id: user.id, username: user.username },
    };
  }

  /** 登出（6.1）：吊销对应 Refresh Token（幂等，令牌不存在也视为成功） */
  async logout(refreshToken: string): Promise<{ ok: true }> {
    await this.refreshTokens
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('token_hash = :tokenHash AND revoked_at IS NULL', {
        tokenHash: hashRefreshToken(refreshToken),
      })
      .execute();
    return { ok: true };
  }

  /**
   * 找回密码（3.1.1 方式① / 6.1）：校验密保答案后重置密码，
   * 重置成功后吊销该用户全部 Refresh Token。
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ ok: true }> {
    const user = await this.users.findOne({ where: { username: dto.username } });
    if (!user || user.status !== USER_STATUS.NORMAL) {
      throw new BadRequestException('用户不存在或密保答案错误');
    }
    const ok = await bcrypt.compare(
      normalizeSecurityAnswer(dto.securityAnswer),
      user.securityAnswerHash,
    );
    if (!ok) throw new BadRequestException('用户不存在或密保答案错误');

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await runInTransaction(this.dataSource, async (manager) => {
      await manager.update(User, { id: user.id }, { passwordHash });
      await this.revokeAllRefreshTokens(manager, user.id);
    });
    return { ok: true };
  }

  /** 查询用户密保问题（前端找回密码页展示用；6.1 未定义 —— 文档外补充） */
  async getSecurityQuestion(username: string): Promise<{ question: string }> {
    const user = await this.users.findOne({ where: { username } });
    if (!user || user.status !== USER_STATUS.NORMAL) {
      throw new BadRequestException('用户不存在');
    }
    return { question: user.securityQuestion };
  }

  /** 吊销该用户全部未吊销 Refresh Token（改密/密保重置时调用；注销走整行删除） */
  async revokeAllRefreshTokens(manager: EntityManager, userId: number): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(RefreshToken)
      .set({ revokedAt: new Date() })
      .where('user_id = :userId AND revoked_at IS NULL', { userId })
      .execute();
  }

  /** 签发 Access（2h，见 AuthModule JwtModule signOptions）+ Refresh（哈希落库，可吊销） */
  private async issueTokens(user: User, rememberMe: boolean): Promise<TokenBundle> {
    const accessToken = await this.jwtService.signAsync({ sub: user.id, username: user.username });
    const ttlMs = rememberMe ? REMEMBER_REFRESH_TTL_MS : REFRESH_TTL_MS;
    const refreshToken = randomBytes(48).toString('hex');
    await this.refreshTokens.save(
      this.refreshTokens.create({
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + ttlMs),
      }),
    );
    return {
      accessToken,
      refreshToken,
      user: { id: user.id, username: user.username },
    };
  }
}
