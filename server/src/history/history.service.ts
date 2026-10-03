import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GameSession, GameSessionStatus } from '../entities/game-session.entity';

/**
 * 对决历史与统计（docs/开发文档.md 3.10 / 6.3）。
 *
 * 设计口径（任务书 §1/§2 钦定）：
 * - 历史 = game_sessions 查询派生，不新建冗余表；「完赛」= 进入结算（status ≠ 进行），
 *   与 M4 成就口径一致，含超时托管局；
 * - 结果映射【钦定】：settlement.reason ∈ {deal, counter}（DB status=成交）→ 成交离场；
 *   keep/swap（DB status=终局）→ 终局开牌；超时托管按七章.5 固定 keep，归入终局开牌
 *   （DB status=超时结算 → 终局开牌）；
 * - 实际盈亏 = 既有 net_profit 口径（到手 − 入场费），禁止另造计算路径；亏损局税额 0；
 * - 列表按 finished_at 倒序、永久保存（账号注销沿用 M1 级联删除语义）；
 * - 查询走 5.2 的 (user_id, finished_at) 索引（IDX_game_sessions_user_finished，M2 已建）；
 * - 金额一律 INTEGER 分（铁律 4）。
 */
/** 分页大小【文档未定义 → 文档外补充：钦定 pageSize=20】 */
export const HISTORY_PAGE_SIZE = 20;

/** 3.10 结果标签（中文逐字） */
export type HistoryOutcome = '成交离场' | '终局开牌';

/** 单条历史记录（3.10 逐字 7 字段 + sessionId 作行标识【文档外补充】） */
export interface HistoryItemView {
  /** 行标识（M1 自增主键；仅用于列表 key / 前端渲染，文档外补充） */
  sessionId: number;
  /** 对局时间（精确到分钟，服务器本地时间 YYYY-MM-DD HH:mm） */
  matchedAt: string;
  /** 档位 1–5 */
  tier: number;
  /** 入场消耗（分） */
  entryFeeFen: number;
  /** 结果：成交离场 / 终局开牌 */
  outcome: HistoryOutcome;
  /** 最终报价或开牌奖金（分；= game_sessions.final_bonus） */
  finalAmountFen: number;
  /** 税额（分；亏损局为 0） */
  taxFen: number;
  /** 实际盈亏（分；= net_profit 口径，可为负） */
  netProfitFen: number;
}

export interface HistoryListView {
  items: HistoryItemView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** GET /api/history/stats 统计面板（3.10 六项） */
export interface HistoryStatsView {
  /** 累计对局数（完赛口径 = 进入结算即算，含托管局） */
  totalMatches: number;
  /** 累计净盈亏（单值，分；与 3.2「总盈亏」同源 = SUM(net_profit)） */
  totalNetProfitFen: number;
  /** 总体胜率【钦定：盈利局/完赛总局，保本入分母不算胜】；4 位小数【文档外补充】 */
  winRate: number;
  /** 单局最高盈利（分；MAX(net_profit)，无完赛局为 0）【文档外补充：无局时取 0】 */
  maxNetProfitFen: number;
  /** 各档位参与分布（1–5 全列，含 0，便于前端固定渲染）【文档外补充：含零档】 */
  tierDistribution: { tier: number; count: number }[];
  /** 累计交税总额（分） */
  totalTaxFen: number;
}

type HistoryResultFilter = 'profit' | 'loss' | 'even';

/** finished_at → 本地时间「精确到分钟」字符串（3.10 逐字口径；秒/毫秒截断不进位） */
function formatMinute(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** DB status → 结果标签（结果映射【钦定】，见类注释） */
export function outcomeOfStatus(status: GameSessionStatus): HistoryOutcome {
  return status === GameSessionStatus.Deal ? '成交离场' : '终局开牌';
}

@Injectable()
export class HistoryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * GET /api/history?tier=&result=&page=（6.3）。
   * server 强制 user_id 过滤（越权只能看自己，铁律 3 延伸）。
   */
  async list(
    userId: number,
    query: { tier?: number; result?: HistoryResultFilter; page?: number },
  ): Promise<HistoryListView> {
    const page = query.page ?? 1;
    const qb = this.dataSource
      .getRepository(GameSession)
      .createQueryBuilder('s')
      .where('s.user_id = :userId', { userId })
      .andWhere('s.status != :playing', { playing: GameSessionStatus.Playing });
    if (query.tier !== undefined) {
      qb.andWhere('s.tier = :tier', { tier: query.tier });
    }
    if (query.result === 'profit') {
      qb.andWhere('s.net_profit > 0');
    } else if (query.result === 'loss') {
      qb.andWhere('s.net_profit < 0');
    } else if (query.result === 'even') {
      qb.andWhere('s.net_profit = 0');
    }
    const [rows, total] = await qb
      .orderBy('s.finished_at', 'DESC')
      .addOrderBy('s.id', 'DESC')
      .skip((page - 1) * HISTORY_PAGE_SIZE)
      .take(HISTORY_PAGE_SIZE)
      .getManyAndCount();

    return {
      items: rows.map((s) => this.toItemView(s)),
      page,
      pageSize: HISTORY_PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
    };
  }

  /**
   * GET /api/history/stats（3.10 统计面板 6 项）。
   * 全部为聚合查询；0 局时全部为 0 / 空分布不报错（空态口径）。
   */
  async stats(userId: number): Promise<HistoryStatsView> {
    const settled = await this.dataSource
      .getRepository(GameSession)
      .createQueryBuilder('s')
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(SUM(s.net_profit), 0)', 'totalNetProfit')
      .addSelect('COALESCE(SUM(CASE WHEN s.net_profit > 0 THEN 1 ELSE 0 END), 0)', 'winCount')
      .addSelect('COALESCE(MAX(s.net_profit), 0)', 'maxNetProfit')
      .addSelect('COALESCE(SUM(s.tax), 0)', 'totalTax')
      .where('s.user_id = :userId', { userId })
      .andWhere('s.status != :playing', { playing: GameSessionStatus.Playing })
      .getRawOne<{
        total: number | string;
        totalNetProfit: number | string;
        winCount: number | string;
        maxNetProfit: number | string;
        totalTax: number | string;
      }>();

    const totalMatches = Number(settled?.total ?? 0);
    const winCount = Number(settled?.winCount ?? 0);
    const tierRows = await this.dataSource
      .getRepository(GameSession)
      .createQueryBuilder('s')
      .select('s.tier', 'tier')
      .addSelect('COUNT(*)', 'count')
      .where('s.user_id = :userId', { userId })
      .andWhere('s.status != :playing', { playing: GameSessionStatus.Playing })
      .groupBy('s.tier')
      .getRawMany<{ tier: number | string; count: number | string }>();
    const byTier = new Map(tierRows.map((r) => [Number(r.tier), Number(r.count)]));

    return {
      totalMatches,
      totalNetProfitFen: Number(settled?.totalNetProfit ?? 0),
      // 保本入分母不算胜（钦定）；winRate 保留 4 位小数（文档外补充，非金额不受铁律 4 约束）
      winRate: totalMatches === 0 ? 0 : Math.round((winCount / totalMatches) * 10000) / 10000,
      maxNetProfitFen: Number(settled?.maxNetProfit ?? 0),
      tierDistribution: [1, 2, 3, 4, 5].map((tier) => ({ tier, count: byTier.get(tier) ?? 0 })),
      totalTaxFen: Number(settled?.totalTax ?? 0),
    };
  }

  /** 行 → 7 字段视图（3.10 逐字口径） */
  private toItemView(s: GameSession): HistoryItemView {
    return {
      sessionId: s.id,
      matchedAt: formatMinute(s.finishedAt ?? s.startedAt),
      tier: s.tier,
      entryFeeFen: s.entryFee,
      outcome: outcomeOfStatus(s.status as GameSessionStatus),
      finalAmountFen: s.finalBonus ?? 0,
      taxFen: s.tax ?? 0,
      netProfitFen: s.netProfit ?? 0,
    };
  }
}
