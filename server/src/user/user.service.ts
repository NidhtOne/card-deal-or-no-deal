import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, Repository } from 'typeorm';
import { FundFlow } from '../entities/fund-flow.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserProfile } from '../entities/user-profile.entity';
import { UserSettings } from '../entities/user-settings.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { User } from '../entities/user.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
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
    await this.dataSource.transaction(async (manager) => {
      await manager.update(User, { id: userId }, { passwordHash });
      await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('user_id = :userId AND revoked_at IS NULL', { userId })
        .execute();
    });
  }

  /**
   * 账号注销（3.1.3；6.1/6.2 未定义 —— 文档外补充）：
   * 事务内删除该用户全部数据（users/profiles/wallets/settings/fund_flows/refresh_tokens），
   * 吊销全部令牌（随 refresh_tokens 整行删除）。
   * 对局历史表（game_sessions 等）在 M2 阶段建表后纳入本事务一并删除（3.1.3 默认直接删除）。
   */
  async deleteAccount(userId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(RefreshToken, { userId });
      await manager.delete(FundFlow, { userId });
      await manager.delete(UserSettings, { userId });
      await manager.delete(UserWallet, { userId });
      await manager.delete(UserProfile, { userId });
      // TODO(M2)：game_sessions / game_cards / offers / daily_signins / 任务 / 救助 / 成就记录
      await manager.delete(User, { id: userId });
    });
  }
}
