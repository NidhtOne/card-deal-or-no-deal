import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, In, Repository } from 'typeorm';
import { parseDbDate } from '../common/db-date';
import { isUniqueViolation } from '../common/db-error';
import { runInTransaction } from '../common/transaction';
import { FundFlow } from '../entities/fund-flow.entity';
import { GameSession } from '../entities/game-session.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserCharacterImage } from '../entities/user-character-image.entity';
import { UserProfile } from '../entities/user-profile.entity';
import { UserSettings } from '../entities/user-settings.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { User } from '../entities/user.entity';
import { AssetCatalogService } from '../upload/asset-catalog.service';
import { UploadedImage, UploadService } from '../upload/upload.service';
import { UpdateProfileDto, UpdateSettingsDto } from './dto/user.dto';

/** 用户名修改频率限制：1 次/30 天（3.2） */
const USERNAME_CHANGE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
/** 角色立绘历史保留张数（3.3：保留最近 3 张历史图供切换） */
const KEEP_CHARACTER_HISTORY = 3;

/** GET /api/user/profile 返回结构 */
export interface ProfileView {
  username: string;
  nickname: string | null;
  signature: string | null;
  avatarUrl: string | null;
  characterUrl: string | null;
  bankerCharacterUrl: string | null;
  /** 上次修改用户名时间（ISO 字符串；从未修改为 null，首改直接允许） */
  usernameChangedAt: string | null;
}

/** GET /api/user/settings 返回结构（8 个设置字段 + 曲目白名单） */
export interface SettingsView {
  bgmEnabled: boolean;
  bgmTrack: string;
  volume: number;
  sfxEnabled: boolean;
  sfxVolume: number;
  amountListEnabled: boolean;
  riskPopupEnabled: boolean;
  achievementEnabled: boolean;
  /** 可选曲目白名单（assets/music/ 现有文件；文档外补充，供前端渲染选项） */
  availableTracks: string[];
}

/**
 * GET /api/user/overview 返回结构（6.2 未定义 —— 文档外补充，落实 3.2「账户信息/数据概览」）。
 * balance 为真实值（单位：分）；后六项属签到/救助/对局统计，M4 阶段接真实逻辑，先返回占位默认值。
 */
export interface OverviewView {
  balance: number;
  todaySignedIn: boolean; // M4 占位
  signinStreakDays: number; // M4 占位
  todayBailoutUsed: number; // M4 占位
  totalMatches: number; // M4 占位
  totalProfit: number; // M4 占位（单位：分）
  winRate: number; // M4 占位（0-1）
}

/** 角色立绘历史项（GET /api/user/character/history，6.2 未定义 —— 文档外补充） */
export interface CharacterHistoryView {
  activeUrl: string | null;
  items: { id: number; url: string; createdAt: string }[];
}

/** 内置银行家选项（GET /api/user/banker-options，6.2 未定义 —— 文档外补充，供前端渲染列表） */
export interface BankerOptionsView {
  builtin: { filename: string; url: string }[];
  /** 当前生效值；为空表示使用内置默认（3.3/5.1：banker_character_url 为空则用内置默认） */
  currentUrl: string | null;
  /** 内置默认（列表第一项）；无内置文件时为 null */
  defaultUrl: string | null;
}

@Injectable()
export class UserService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(UserProfile) private readonly profiles: Repository<UserProfile>,
    @InjectRepository(UserSettings) private readonly settings: Repository<UserSettings>,
    @InjectRepository(UserWallet) private readonly wallets: Repository<UserWallet>,
    @InjectRepository(UserCharacterImage)
    private readonly characterImages: Repository<UserCharacterImage>,
    private readonly uploadService: UploadService,
    private readonly assetCatalog: AssetCatalogService,
  ) {}

  /**
   * 修改密码（6.2 POST /api/user/password）：验证原密码；
   * 修改成功后吊销该用户全部 Refresh Token（安全起见要求重新登录）。
   */
  async changePassword(userId: number, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('账号不存在或已注销');
    const ok = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedException('原密码错误');

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await runInTransaction(this.dataSource, async (manager) => {
      await manager.update(User, { id: userId }, { passwordHash });
      await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('user_id = :userId AND revoked_at IS NULL', { userId })
        .execute();
    });
  }

  /** GET /api/user/profile —— 获取资料（users + user_profiles 合并视图） */
  async getProfile(userId: number): Promise<ProfileView> {
    const { user, profile } = await this.getUserAndProfile(userId);
    return {
      username: user.username,
      nickname: profile.nickname,
      signature: profile.signature,
      avatarUrl: profile.avatarUrl,
      characterUrl: profile.characterUrl,
      bankerCharacterUrl: profile.bankerCharacterUrl,
      usernameChangedAt: parseDbDate(profile.usernameChangedAt)?.toISOString() ?? null,
    };
  }

  /**
   * PUT /api/user/profile —— 更新资料（3.2）：
   * 用户名修改限 1 次/30 天（username_changed_at 为 NULL 时首改直接允许，距上次 ≥30 天允许）；
   * 重名由 users.username UNIQUE 约束兜底 409。昵称/签名空字符串视为清除（存 NULL）。
   *
   * M1 修复（文档外补充）：用户名修改放入单个事务，先执行条件 UPDATE 原子盖章
   * （并发/重复请求下只有一方 affected=1），再改 users.username；
   * 撞 users.username UNIQUE 时事务回滚使盖章自动撤销 —— 改名失败不消耗 30 天额度。
   */
  async updateProfile(userId: number, dto: UpdateProfileDto): Promise<ProfileView> {
    const { user } = await this.getUserAndProfile(userId);

    if (dto.username !== undefined && dto.username !== user.username) {
      const newUsername = dto.username;
      await this.withUsernameLock(userId, async () => {
        const now = new Date();
        const threshold = new Date(now.getTime() - USERNAME_CHANGE_INTERVAL_MS);
        try {
          // 锁与事务嵌套顺序保持：用户级锁在外，全局写事务互斥在内
          await runInTransaction(this.dataSource, async (manager) => {
            // 原子占位：条件 UPDATE 盖章（threshold = now - 30 天，与报错口径一致）
            const stamp = await manager
              .createQueryBuilder()
              .update(UserProfile)
              .set({ usernameChangedAt: now })
              .where('user_id = :userId', { userId })
              .andWhere('(username_changed_at IS NULL OR username_changed_at <= :threshold)', {
                threshold,
              })
              .execute();
            if (!stamp.affected) {
              const latest = await manager.findOne(UserProfile, { where: { userId } });
              const changedAt = parseDbDate(latest?.usernameChangedAt);
              const nextAt = new Date(
                (changedAt?.getTime() ?? now.getTime()) + USERNAME_CHANGE_INTERVAL_MS,
              );
              throw new BadRequestException(
                `用户名每 30 天仅可修改一次，下次可修改时间：${nextAt.toISOString()}`,
              );
            }
            await manager.update(User, { id: userId }, { username: newUsername });
          });
        } catch (e) {
          if (isUniqueViolation(e)) throw new ConflictException('用户名已被占用');
          throw e;
        }
      });
    }

    if (dto.nickname !== undefined) {
      const v = dto.nickname.trim();
      await this.profiles.update({ userId }, { nickname: v === '' ? null : v });
    }
    if (dto.signature !== undefined) {
      const v = dto.signature.trim();
      await this.profiles.update({ userId }, { signature: v === '' ? null : v });
    }
    return this.getProfile(userId);
  }

  /**
   * 用户名修改串行锁（M1 修复 —— 文档外补充）：
   * better-sqlite3 驱动全局仅一条连接，TypeORM 并发事务会以 SAVEPOINT 嵌套进同一底层事务，
   * 一方的 ROLLBACK TO SAVEPOINT 可能误伤另一方已写入的数据；用户名修改属罕见低频操作，
   * 按用户串行化即可消除该竞态（本地单用户场景开销可忽略）。
   */
  private readonly usernameLocks = new Map<number, Promise<unknown>>();

  private async withUsernameLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.usernameLocks.get(userId) ?? Promise.resolve();
    const tail = prev.catch(() => undefined).then(() => fn());
    this.usernameLocks.set(userId, tail);
    try {
      return await tail;
    } finally {
      if (this.usernameLocks.get(userId) === tail) this.usernameLocks.delete(userId);
    }
  }

  /** GET /api/user/settings —— 获取设置（含曲目白名单 availableTracks） */
  async getSettings(userId: number): Promise<SettingsView> {
    const row = await this.getSettingsRow(userId);
    const availableTracks = await this.assetCatalog.listMusicTracks();
    // 曲目文件可被开源用户替换/删除（3.9）：存储值不在当前白名单时回退到白名单第一首（展示层兜底，不回写）
    const bgmTrack = availableTracks.includes(row.bgmTrack)
      ? row.bgmTrack
      : (availableTracks[0] ?? row.bgmTrack);
    return {
      bgmEnabled: row.bgmEnabled,
      bgmTrack,
      volume: row.volume,
      sfxEnabled: row.sfxEnabled,
      sfxVolume: row.sfxVolume,
      amountListEnabled: row.amountListEnabled,
      riskPopupEnabled: row.riskPopupEnabled,
      achievementEnabled: row.achievementEnabled,
      availableTracks,
    };
  }

  /** PUT /api/user/settings —— 部分更新；bgm_track 校验白名单（assets/music/ 现有文件） */
  async updateSettings(userId: number, dto: UpdateSettingsDto): Promise<SettingsView> {
    await this.getSettingsRow(userId);
    if (dto.bgmTrack !== undefined) {
      const tracks = await this.assetCatalog.listMusicTracks();
      if (!tracks.includes(dto.bgmTrack)) {
        throw new BadRequestException('背景音乐曲目不存在');
      }
    }
    const patch: Partial<UserSettings> = {};
    if (dto.bgmEnabled !== undefined) patch.bgmEnabled = dto.bgmEnabled;
    if (dto.bgmTrack !== undefined) patch.bgmTrack = dto.bgmTrack;
    if (dto.volume !== undefined) patch.volume = dto.volume;
    if (dto.sfxEnabled !== undefined) patch.sfxEnabled = dto.sfxEnabled;
    if (dto.sfxVolume !== undefined) patch.sfxVolume = dto.sfxVolume;
    if (dto.amountListEnabled !== undefined) patch.amountListEnabled = dto.amountListEnabled;
    if (dto.riskPopupEnabled !== undefined) patch.riskPopupEnabled = dto.riskPopupEnabled;
    if (dto.achievementEnabled !== undefined) patch.achievementEnabled = dto.achievementEnabled;
    if (Object.keys(patch).length > 0) {
      await this.settings.update({ userId }, patch);
    }
    return this.getSettings(userId);
  }

  /** GET /api/user/overview —— 账户聚合（6.2 未定义 —— 文档外补充；统计项 M4 接真实逻辑） */
  async getOverview(userId: number): Promise<OverviewView> {
    const wallet = await this.wallets.findOne({ where: { userId } });
    return {
      balance: wallet?.balance ?? 0,
      // 以下六项：3.2 账户信息/数据概览，签到/破产救助/对局统计属 M4 阶段 —— 先返回占位默认值
      todaySignedIn: false,
      signinStreakDays: 0,
      todayBailoutUsed: 0,
      totalMatches: 0,
      totalProfit: 0,
      winRate: 0,
    };
  }

  /**
   * POST /api/user/avatar —— 上传头像（3.2，建议 1:1）。
   * 服务端重编码去 EXIF 并生成多尺寸缩略图；更换时先更库后删旧文件，删文件失败不回滚。
   */
  async updateAvatar(userId: number, file: UploadedImage): Promise<{ url: string }> {
    const saved = await this.uploadService.saveImage(file, 'avatars', 'avatar');
    try {
      const profile = await this.getProfileRow(userId);
      const oldUrl = profile.avatarUrl;
      await this.profiles.update({ userId }, { avatarUrl: saved.url });
      if (oldUrl && oldUrl !== saved.url) {
        await this.uploadService.deleteAvatarSet(oldUrl);
      }
    } catch (e) {
      // L1 修复（文档外补充）：DB 写失败时删除本次新落盘文件（含头像缩略图套件），避免孤儿文件
      await this.uploadService.deleteAvatarSet(saved.url);
      throw e;
    }
    return { url: saved.url };
  }

  /**
   * POST /api/user/character —— 上传用户角色立绘（3.3，推荐 3:4）。
   * 事务内：插入历史记录 + 更新当前生效图 + 淘汰第 4 张起的最旧记录；
   * 事务提交后同删被淘汰记录的磁盘文件（删文件失败不回滚）。
   */
  async uploadCharacter(userId: number, file: UploadedImage): Promise<{ url: string }> {
    const saved = await this.uploadService.saveImage(file, 'characters', 'portrait');
    let evicted: UserCharacterImage[];
    try {
      // L2 说明（文档外补充）：一切写事务经 runInTransaction 全局串行，交叉淘汰窗口消除。
      evicted = await runInTransaction(this.dataSource, async (manager) => {
        await manager.insert(UserCharacterImage, { userId, url: saved.url });
        await manager.update(UserProfile, { userId }, { characterUrl: saved.url });
        const rows = await manager.find(UserCharacterImage, {
          where: { userId },
          order: { createdAt: 'DESC', id: 'DESC' },
        });
        const toEvict = rows.slice(KEEP_CHARACTER_HISTORY);
        if (toEvict.length > 0) {
          await manager.delete(UserCharacterImage, { id: In(toEvict.map((r) => r.id)) });
        }
        return toEvict;
      });
    } catch (e) {
      // L1 修复（文档外补充）：事务失败时删除本次新落盘文件，避免孤儿文件
      await this.uploadService.deleteByUrl(saved.url);
      throw e;
    }
    for (const row of evicted) {
      await this.uploadService.deleteByUrl(row.url);
    }
    return { url: saved.url };
  }

  /** GET /api/user/character/history —— 历史列表（6.2 未定义 —— 文档外补充）；未上传时返回空列表 */
  async getCharacterHistory(userId: number): Promise<CharacterHistoryView> {
    const profile = await this.getProfileRow(userId);
    const rows = await this.characterImages.find({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return {
      activeUrl: profile.characterUrl,
      items: rows.map((r) => ({
        id: r.id,
        url: r.url,
        createdAt: parseDbDate(r.createdAt)?.toISOString() ?? '',
      })),
    };
  }

  /** POST /api/user/character/:id/activate —— 切换生效立绘（6.2 未定义 —— 文档外补充） */
  async activateCharacter(userId: number, imageId: number): Promise<{ url: string }> {
    const row = await this.characterImages.findOne({ where: { id: imageId, userId } });
    if (!row) throw new NotFoundException('角色立绘不存在');
    await this.profiles.update({ userId }, { characterUrl: row.url });
    return { url: row.url };
  }

  /** GET /api/user/banker-options —— 内置银行家列表（6.2 未定义 —— 文档外补充） */
  async getBankerOptions(userId: number): Promise<BankerOptionsView> {
    const profile = await this.getProfileRow(userId);
    const files = await this.assetCatalog.listBankerFiles();
    return {
      builtin: files.map((filename) => ({ filename, url: `/assets/bankers/${filename}` })),
      currentUrl: profile.bankerCharacterUrl,
      defaultUrl: files.length > 0 ? `/assets/bankers/${files[0]}` : null,
    };
  }

  /**
   * 「选择内置」银行家（6.2 POST /api/user/banker-character 的 JSON 模式）：
   * 白名单校验仅允许 assets/bankers/ 下现有文件，拒绝路径穿越（拒绝一切含分隔符/.. 的文件名，
   * 再以目录扫描结果精确匹配兜底）。切换到内置后删除旧自定义文件（先更库后删文件）。
   */
  async selectBuiltinBanker(userId: number, filename: string): Promise<{ url: string }> {
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      throw new BadRequestException('非法的内置银行家文件名');
    }
    const files = await this.assetCatalog.listBankerFiles();
    if (!files.includes(filename)) {
      throw new BadRequestException('内置银行家立绘不存在');
    }
    const url = `/assets/bankers/${filename}`;
    const profile = await this.getProfileRow(userId);
    const oldUrl = profile.bankerCharacterUrl;
    await this.profiles.update({ userId }, { bankerCharacterUrl: url });
    if (oldUrl && oldUrl !== url && oldUrl.startsWith('/uploads/')) {
      await this.uploadService.deleteByUrl(oldUrl);
    }
    return { url };
  }

  /** 「上传自定义」银行家（6.2 的 multipart 模式，存 bankers-custom/）；更换时先更库后删旧文件 */
  async uploadCustomBanker(userId: number, file: UploadedImage): Promise<{ url: string }> {
    const saved = await this.uploadService.saveImage(file, 'bankers-custom', 'portrait');
    try {
      const profile = await this.getProfileRow(userId);
      const oldUrl = profile.bankerCharacterUrl;
      await this.profiles.update({ userId }, { bankerCharacterUrl: saved.url });
      if (oldUrl && oldUrl !== saved.url && oldUrl.startsWith('/uploads/')) {
        await this.uploadService.deleteByUrl(oldUrl);
      }
    } catch (e) {
      // L1 修复（文档外补充）：DB 写失败时删除本次新落盘文件，避免孤儿文件
      await this.uploadService.deleteByUrl(saved.url);
      throw e;
    }
    return { url: saved.url };
  }

  /**
   * 账号注销（3.1.3；6.1/6.2 未定义 —— 文档外补充）：
   * 事务内删除该用户全部数据（users/profiles/wallets/settings/fund_flows/refresh_tokens/
   * user_character_images），吊销全部令牌（随 refresh_tokens 整行删除）；
   * 事务提交后删除该用户全部磁盘上传文件（avatars/characters/bankers-custom，删文件失败不回滚）。
   * 对局表（M2：offers / game_cards / game_sessions，先子表后主表）随注销一并删除。
   */
  async deleteAccount(userId: number): Promise<void> {
    // 事务前先收集磁盘文件清单（URL 来自该用户自己的 DB 记录）
    const profile = await this.profiles.findOne({ where: { userId } });
    const characterImages = await this.characterImages.find({ where: { userId } });
    const fileUrls: string[] = characterImages.map((r) => r.url);
    if (profile?.bankerCharacterUrl?.startsWith('/uploads/')) {
      fileUrls.push(profile.bankerCharacterUrl);
    }

    await runInTransaction(this.dataSource, async (manager) => {
      await manager.delete(RefreshToken, { userId });
      await manager.delete(FundFlow, { userId });
      await manager.delete(UserCharacterImage, { userId }); // 文档外补充表，随注销级联删除
      await manager.delete(UserSettings, { userId });
      await manager.delete(UserWallet, { userId });
      await manager.delete(UserProfile, { userId });
      // 对局表（M2）：先删子表 offers / game_cards，再删 game_sessions
      await manager.query(
        'DELETE FROM offers WHERE session_id IN (SELECT id FROM game_sessions WHERE user_id = ?)',
        [userId],
      );
      await manager.query(
        'DELETE FROM game_cards WHERE session_id IN (SELECT id FROM game_sessions WHERE user_id = ?)',
        [userId],
      );
      await manager.delete(GameSession, { userId });
      // TODO(M4)：daily_signins / 任务 / 救助 / 成就记录
      await manager.delete(User, { id: userId });
    });

    // 事务提交后删除磁盘上传文件（失败仅记录日志，不回滚）
    if (profile?.avatarUrl) {
      await this.uploadService.deleteAvatarSet(profile.avatarUrl);
    }
    for (const url of fileUrls) {
      await this.uploadService.deleteByUrl(url);
    }
  }

  private async getUserAndProfile(
    userId: number,
  ): Promise<{ user: User; profile: UserProfile }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('账号不存在或已注销');
    const profile = await this.getProfileRow(userId);
    return { user, profile };
  }

  private async getProfileRow(userId: number): Promise<UserProfile> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) throw new NotFoundException('用户资料不存在');
    return profile;
  }

  /** 设置行兜底：注册时已随事务创建；历史脏数据缺失时按 3.7 默认值补建 */
  private async getSettingsRow(userId: number): Promise<UserSettings> {
    let row = await this.settings.findOne({ where: { userId } });
    if (!row) {
      try {
        row = await this.settings.save(this.settings.create({ userId }));
      } catch (e) {
        // L3 修复（文档外补充）：并发补建撞 user_id UNIQUE 时回查已有行返回，不抛 500
        if (!isUniqueViolation(e)) throw e;
        row = await this.settings.findOne({ where: { userId } });
        if (!row) throw e;
      }
    }
    return row;
  }
}
