import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Achievement } from '../entities/achievement.entity';
import { BailoutRecord } from '../entities/bailout-record.entity';
import { DailySignin } from '../entities/daily-signin.entity';
import { DailyTask } from '../entities/daily-task.entity';
import { FundFlow } from '../entities/fund-flow.entity';
import { GameSession } from '../entities/game-session.entity';
import { UserAchievement } from '../entities/user-achievement.entity';
import { UserSettings } from '../entities/user-settings.entity';
import { UserTaskProgress } from '../entities/user-task-progress.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { MatchModule } from '../match/match.module';
import { WalletModule } from '../wallet/wallet.module';
import { AchievementsService } from './achievements.service';
import { BailoutService } from './bailout.service';
import { EconomyController } from './economy.controller';
import { SigninService } from './signin.service';
import { TasksService } from './tasks.service';

/**
 * 经济系统模块（M4 第一期：签到/每日任务/破产救助/成就；历史与统计本阶段不含）。
 * 统一约束回落点：
 * - 一切写事务经 common/transaction.runInTransaction（全局 FIFO 互斥），资金变动唯一入口
 *   为 WalletService.adjustBalance（铁律 1/2）；
 * - 「今日」以注入 CLOCK 换算服务器本地日期（common/local-date.ts），e2e 假时钟断言跨天；
 * - 数值唯一来源 config/economy.json（铁律 7），模块启动时镜像同步至 daily_tasks /
 *   achievements 定义表；
 * - 时钟依赖注入：CLOCK 令牌由 MatchModule 提供并导出（令牌同源，e2e 一次覆写全生效），
 *   WalletModule/AuthModule 无环。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DailySignin,
      DailyTask,
      UserTaskProgress,
      BailoutRecord,
      Achievement,
      UserAchievement,
      UserSettings,
      UserWallet,
      FundFlow,
      GameSession,
    ]),
    AuthModule,
    MatchModule, // CLOCK（注入时钟）+ GameSessionService 复用
    WalletModule,
  ],
  controllers: [EconomyController],
  providers: [SigninService, TasksService, BailoutService, AchievementsService],
  exports: [SigninService, TasksService, BailoutService, AchievementsService],
})
export class EconomyModule {}
