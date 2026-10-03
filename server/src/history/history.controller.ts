import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthUserPayload, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HistoryQueryDto } from './dto/history-query.dto';
import { HistoryListView, HistoryService, HistoryStatsView } from './history.service';

/**
 * 对决历史接口（路径与 docs/开发文档.md 6.3 逐字一致：GET /api/history、GET /api/history/stats）。
 * 数据全部派生自 game_sessions（不新建冗余表）；server 强制 user_id 过滤，越权只能看自己。
 */
@Controller('history')
@UseGuards(JwtAuthGuard)
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  /** GET /api/history?tier=&result=&page= —— 历史列表（3.10：倒序 / 档位与结果筛选 / 分页） */
  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Query() query: HistoryQueryDto,
  ): Promise<HistoryListView> {
    return this.history.list(user.userId, {
      tier: query.tier,
      result: query.result,
      page: query.page,
    });
  }

  /** GET /api/history/stats —— 统计面板（3.10 六项聚合；0 局全 0 不报错） */
  @Get('stats')
  stats(@CurrentUser() user: AuthUserPayload): Promise<HistoryStatsView> {
    return this.history.stats(user.userId);
  }
}
