import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { GameSession } from '../entities/game-session.entity';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

/**
 * 对决历史与统计模块（M5 阶段 7：docs/开发文档.md 3.10 / 6.3 / 第四章 /history）。
 * 历史为查询派生（无新表、无迁移）；导出 HistoryService 供 UserModule 的
 * overview「数据概览」复用（3.2 与 3.10 统计同源）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([GameSession]), AuthModule],
  controllers: [HistoryController],
  providers: [HistoryService],
  exports: [HistoryService],
})
export class HistoryModule {}
