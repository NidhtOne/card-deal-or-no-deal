import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { runInTransaction } from '../common/transaction';
import { CLOCK, type Clock } from '../match/clock';
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

/**
 * 过期清理调度间隔（进程内 setInterval）【文档外补充：2026-10-03 人工决策落地】。
 * 铁律（任务书 §21）：禁止新增依赖（无 @nestjs/schedule），定时用进程内 interval，
 * 句柄随 onModuleDestroy 清理防测试泄漏；e2e/单测直接调 purgeExpired 断言，不依赖真实定时。
 */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
/** 每批删除上限（防长事务）【文档外补充】 */
const PURGE_BATCH_SIZE = 500;

/** DB status → 结果标签（结果映射【钦定】，见类注释） */
export function outcomeOfStatus(status: GameSessionStatus): HistoryOutcome {
  return status === GameSessionStatus.Deal ? '成交离场' : '终局开牌';
}

@Injectable()
export class HistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HistoryService.name);
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    // M8【文档外补充】注入时钟：调度/清理的「现在」统一走 CLOCK 令牌（禁止散落 Date.now）
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 启动完成后执行一次 + 之后每 1 小时触发（interval 句柄随 close 清理） */
  async onModuleInit(): Promise<void> {
    await this.purgeExpired(this.clock.now()).catch((e) =>
      this.logger.error('历史过期清理失败（启动）', e as Error),
    );
    this.purgeTimer = setInterval(() => {
      void this.purgeExpired(this.clock.now()).catch((e) =>
        this.logger.error('历史过期清理失败', e as Error),
      );
    }, PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }

  /**
   * 过期清理【文档外补充：2026-10-03 人工决策落地】（人工决策原文：对局历史自动清理，
   * 保留多久在设置中由用户自行决定）：
   * - 按用户各自 user_settings.history_retention_days 删除 game_sessions 中
   *   finished_at < now − retention×24h 的行；retention=0（永久保留）的用户不删；
   * - 删除 = 物理 DELETE，删后自然从列表与统计消失（符合决策原意）；
   * - 不删 fund_flows（资金流水是账本，永久保留）；与对局写入无冲突（删的是 finished 旧记录），
   *   仍走 runInTransaction 分批删除（每批 ≤500 行防长事务）。
   * 返回本次删除总行数（时钟可注入：测试直接传 now 断言）。
   */
  async purgeExpired(now: number): Promise<number> {
    const retentionRows = (await this.dataSource.query(
      'SELECT user_id, history_retention_days FROM "user_settings" WHERE history_retention_days > 0',
    )) as { user_id: number; history_retention_days: number }[];
    let totalDeleted = 0;
    for (const row of retentionRows) {
      const userId = Number(row.user_id);
      const retentionDays = Number(row.history_retention_days);
      // M8-fix1【文档外补充：2026-10-03 人工决策落地】：截止时刻显式格式化为
      // 与 finished_at 一致的秒精度 UTC datetime。若直接传 Date，驱动会序列化出毫秒，
      // SQLite 文本比较会把恰好到期的「...00」误判为小于「...00.000」，违反严格 < 边界。
      const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      for (;;) {
        const deleted = await runInTransaction(this.dataSource, async (manager) => {
          // 每批 ≤ PURGE_BATCH_SIZE 行（防长事务）：先选 id 再删（manager.delete 可得
          // affected 数；offers/game_cards 对 game_sessions 为 ON DELETE CASCADE，随删级联）
          const ids = await manager
            .getRepository(GameSession)
            .createQueryBuilder('s')
            .select('s.id', 'id')
            .where('s.user_id = :userId', { userId })
            .andWhere('s.finished_at IS NOT NULL')
            .andWhere('s.finished_at < :cutoff', { cutoff })
            .limit(PURGE_BATCH_SIZE)
            .getRawMany<{ id: number | string }>();
          if (ids.length === 0) return 0;
          const result = await manager.delete(GameSession, {
            id: In(ids.map((r) => Number(r.id))),
          });
          return result.affected ?? 0;
        });
        totalDeleted += deleted;
        if (deleted < PURGE_BATCH_SIZE) break;
      }
    }
    if (totalDeleted > 0) {
      this.logger.log(`历史过期清理完成：删除 ${totalDeleted} 行`);
    }
    return totalDeleted;
  }

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
