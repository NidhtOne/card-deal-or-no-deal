import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { GameSession } from '../entities/game-session.entity';
// M8：过期清理读用户保留天数 + 注入 CLOCK【文档外补充：2026-10-03 人工决策落地】
import { UserSettings } from '../entities/user-settings.entity';
import { MatchModule } from '../match/match.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

/**
 * 对决历史与统计模块（M5 阶段 7：docs/开发文档.md 3.10 / 6.3 / 第四章 /history）。
 * 历史为查询派生（无新表、无迁移）；导出 HistoryService 供 UserModule 的
 * overview「数据概览」复用（3.2 与 3.10 统计同源）。
 * M8【文档外补充：2026-10-03 人工决策落地】：新增对局历史过期清理
 * （user_settings.history_retention_days，调度为进程内 interval，不新增依赖）；
 * 导入 MatchModule 仅为复用 CLOCK 注入时钟令牌（清理判定的「现在」统一口径）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([GameSession, UserSettings]), AuthModule, MatchModule],
  controllers: [HistoryController],
  providers: [HistoryService],
  exports: [HistoryService],
})
export class HistoryModule {}
