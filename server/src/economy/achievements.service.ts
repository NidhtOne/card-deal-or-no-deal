import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { runInTransaction } from '../common/transaction';
import { getEconomyExt, type AchievementDefConfig } from '../config/economy';
import { Achievement } from '../entities/achievement.entity';
import { FundFlow, FundFlowType } from '../entities/fund-flow.entity';import { UserAchievement } from '../entities/user-achievement.entity';
import { UserSettings } from '../entities/user-settings.entity';
import { CLOCK, type Clock } from '../match/clock';
import type { MatchSettledPayload } from '../match/match-events';
import { WalletService } from '../wallet/wallet.service';

/**
 * 成就代码常量（业务钩子与 config/economy.json achievements.list[].code 的绑定约定，
 * 代码与配置必须一一对应，缺失配置即启动期判定报错 —— 文档外补充，注释标注）。
 */
export const ACH = {
  /** 初出茅庐：完成第一局任意档位 */
  FIRST_MATCH: 'first_match',
  /** 百万梦想：单局税前奖金 ≥ 1,000,000 */
  MILLION_DREAM: 'million_dream',
  /** 博弈到底：拒绝所有报价并终局换牌结算（仅 swap 解锁；keep 不解锁，见 evaluate 内钦定注释） */
  NEVER_DEAL: 'never_deal',
  /** 东山再起：领取破产救助后完成一局盈利对局 */
  COMEBACK: 'comeback',
  /** 连胜猎手：连续 5 局盈利 */
  WIN_STREAK: 'win_streak',
  /** 勤劳玩家：累计 100 局 */
  HUNDRED_GAMES: 'hundred_games',
} as const;

/** 带启动同步行 id 的成就定义 */
interface ResolvedAchievementDef extends AchievementDefConfig {
  id: number;
}

/** GET /api/achievements 成就项（文档 6.3 未定义响应体 —— 文档外补充；金额一律整数分） */
export interface AchievementItemView {
  code: string;
  name: string;
  /** 奖励（分） */
  rewardFen: number;
  /** 已解锁（达成，待领取或已领取） */
  unlocked: boolean;
  /** 奖励已领取 */
  claimed: boolean;
  unlockedAt: string | null;
}

export interface AchievementsView {
  /**
   * 成就总开关（user_settings.achievement_enabled）。
   * 【钦定口径，注释标注】off 时前端不弹窗不展示，但本接口仍返回后台照常累计的
   * 解锁/待领取记录（文档未定义，防一次性成就永久错过），重新开启后可见。
   */
  enabled: boolean;
  list: AchievementItemView[];
}

export interface ClaimAchievementView {
  code: string;
  rewardFen: number;
  balanceFen: number;
  /** 幂等回放 = true（重复领取返回已领取，不再产生第二条流水） */
  alreadyClaimed: boolean;
}

/**
 * 成就系统（docs/开发文档.md 3.8.5）：一次性解锁 + 达成待领取 + 手动领取。
 * 【钦定口径，均为文档未定义，注释标注 + 待人工确认】：
 * a. 全部成就判定在对局结算事件（match_settled，含 3.6.8 超时托管结算路径）统一执行；
 * b. 「完成/累计」口径：对局进入结算状态即算 1 局（初出茅庐/勤劳玩家），含托管局；
 * c. 「盈利」口径：net_profit > 0；保本（=0）不算盈利也不算亏损；亏损 < 0；
 * d. 连胜猎手（口径冻结，文档未定义，待人工最终确认）：「保本截断」——从最新结算向
 *    历史按 finished_at 倒序追溯，盈利 +1，遇 net_profit ≤ 0（含保本）即停止；保本局
 *    不计入连胜长度、也不归零其前段（分段子段保留，例：「盈、保本、盈×4」当前连胜为
 *    4，不解锁）；亏损局同样终止追溯，此后再盈×5 重新解锁。实时查询推导，不新增持久化字段；
 * e. 东山再起：存在任一已救助流水（fund_flows type=救助）后，其后结算的第一局
 *    盈利对局即解锁；资格持久，亏损局不重置 —— 文档未定义，按此口径实现；
 * f. achievement_enabled=off：不弹窗不展示，后台判定与待领取记录照常累计，
 *    重新开启后可见（文档未定义）。
 */
@Injectable()
export class AchievementsService implements OnModuleInit {
  private readonly logger = new Logger(AchievementsService.name);
  /** 启动同步后的成就定义（含 achievements 行 id；config 顺序即展示顺序） */
  private defs: ResolvedAchievementDef[] = [];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly walletService: WalletService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.defs = await runInTransaction(this.dataSource, async (manager) => {
      const configs = getEconomyExt().achievements;
      const rows = await manager.find(Achievement);
      const byCode = new Map(rows.map((r) => [r.code, r]));
      const resolved: ResolvedAchievementDef[] = [];
      for (const cfg of configs) {
        // 条件参数完整性校验（业务所需参数缺失时 fail fast，启动期拒绝运行）
        this.assertParams(cfg);
        const existed = byCode.get(cfg.code);
        if (existed) {
          await manager.update(
            Achievement,
            { id: existed.id },
            { name: cfg.name, reward: cfg.rewardFen },
          );
          resolved.push({ ...cfg, id: existed.id });
        } else {
          const row = await manager.save(
            Achievement,
            manager.create(Achievement, {
              code: cfg.code,
              name: cfg.name,
              reward: cfg.rewardFen,
            }),
          );
          resolved.push({ ...cfg, id: row.id });
        }
      }
      const alive = new Set(configs.map((c) => c.code));
      for (const r of rows) {
        if (!alive.has(r.code)) await manager.delete(Achievement, { id: r.id });
      }
      return resolved;
    });
    this.logger.log(`成就定义同步完成：${this.defs.length} 项`);
  }

  /** 条件参数完整性：各成就代码所需 config 参数缺失即抛错（启动 fail fast） */
  private assertParams(cfg: AchievementDefConfig): void {
    if (cfg.code === ACH.MILLION_DREAM && cfg.prizeThresholdFen === null) {
      throw new Error(`economy.json achievements 配置非法：${cfg.code} 缺 prize_threshold`);
    }
    if (cfg.code === ACH.WIN_STREAK && cfg.streak === null) {
      throw new Error(`economy.json achievements 配置非法：${cfg.code} 缺 streak`);
    }
    if (cfg.code === ACH.HUNDRED_GAMES && cfg.games === null) {
      throw new Error(`economy.json achievements 配置非法：${cfg.code} 缺 games`);
    }
  }

  private def(code: string): ResolvedAchievementDef {
    const d = this.defs.find((x) => x.code === code);
    if (!d) throw new Error(`economy.json achievements 配置非法：缺 ${code} 定义`);
    return d;
  }

  /** 七章.6 / 钦定口径 a：对局结算事件统一判定（含超时托管结算路径） */
  @OnEvent('match_settled')
  handleMatchSettled(payload: MatchSettledPayload): void {
    void this.evaluateOnSettled(payload).catch((e) =>
      this.logger.error(
        `成就判定失败 user=${payload.userId} session=${payload.sessionId}`,
        e as Error,
      ),
    );
  }

  /**
   * 结算时判定（事务内）。返回本次新解锁代码列表。
   * 公开此方法供集成测试直接驱动（与监听 match_settled 事件完全同一路径）。
   */
  async evaluateOnSettled(payload: MatchSettledPayload): Promise<string[]> {
    return runInTransaction(this.dataSource, (manager) => this.evaluate(manager, payload));
  }

  private async evaluate(
    manager: EntityManager,
    payload: MatchSettledPayload,
  ): Promise<string[]> {
    const { userId } = payload;
    const unlocked = await manager.find(UserAchievement, { where: { userId } });
    const unlockedIds = new Set(unlocked.map((r) => r.achievementId));
    const gained: string[] = [];
    const unlock = async (code: string): Promise<void> => {
      const def = this.def(code);
      if (unlockedIds.has(def.id)) return; // 一次性解锁（唯一约束 UQ_user_achievements 兜底）
      await manager.insert(UserAchievement, {
        userId,
        achievementId: def.id,
        unlockedAt: new Date(this.clock.now()),
        claimed: false,
      });
      unlockedIds.add(def.id);
      gained.push(code);
      this.logger.log(`成就解锁 user=${userId} code=${code}`);
    };

    // 初出茅庐：对局进入结算状态即算 1 局（口径 b），本事件即首局结算
    await unlock(ACH.FIRST_MATCH);

    // 百万梦想：单局税前奖金 ≥ 门槛（含边界相等）
    if (payload.settlement.prizeFen >= this.def(ACH.MILLION_DREAM).prizeThresholdFen!) {
      await unlock(ACH.MILLION_DREAM);
    }

    // 博弈到底：拒绝所有报价并终局「换牌」结算（3.8.5 原文：拒绝所有报价并终局换牌结算）。
    // 【钦定口径收窄】仅 reason === 'swap' 解锁；reason === 'keep'（不换牌、保留原卡）
    // 不解锁。另注：超时托管局按七章.5 固定保留底牌（reason=keep），故托管局永不
    // 触发博弈到底（有意为之）。
    if (payload.settlement.reason === 'swap') {
      await unlock(ACH.NEVER_DEAL);
    }

    // 东山再起（口径 e）：存在任一救助流水后，其后结算的第一局盈利对局即解锁；资格持久
    if (payload.netProfitFen > 0) {
      const hasBailout = await manager.findOne(FundFlow, {
        where: { userId, type: FundFlowType.Bailout },
      });
      if (hasBailout) await unlock(ACH.COMEBACK);
    }

    // 连胜猎手 / 勤劳玩家：按 user_id + finished_at 倒序读结算记录（含本局，结算已提交后发事件）
    const history = (await manager.query(
      `SELECT net_profit FROM "game_sessions"
       WHERE user_id = ? AND finished_at IS NOT NULL
       ORDER BY finished_at DESC, id DESC`,
      [userId],
    )) as { net_profit: number | null }[];

    // 连胜猎手（口径 d，文档外补充 + 待人工确认）：盈利 +1；亏损中断清零；
    // 保本（net_profit=0）「不中断但不算连胜」——倒序推导时停在本段首个非盈利局
    // （保本会截断向更早局延伸的连胜段，故「盈/保本/盈×4」序列 = 当前连胜 4，不解锁）。
    let streak = 0;
    for (const row of history) {
      const net = row.net_profit ?? 0;
      if (net > 0) streak += 1;
      else break; // 保本/亏损均终止向更早局追溯
    }
    if (streak >= this.def(ACH.WIN_STREAK).streak!) {
      await unlock(ACH.WIN_STREAK);
    }

    // 勤劳玩家（口径 b）：累计结算局数（含超时托管局 = finished_at 非空即计数）
    if (history.length >= this.def(ACH.HUNDRED_GAMES).games!) {
      await unlock(ACH.HUNDRED_GAMES);
    }

    return gained;
  }

  /** GET /api/achievements：已领取 / 待领取 / 未解锁 全量视图 + 总开关 */
  async list(userId: number): Promise<AchievementsView> {
    const settings = await this.dataSource
      .getRepository(UserSettings)
      .findOne({ where: { userId } });
    const unlocked = await this.dataSource.getRepository(UserAchievement).find({
      where: { userId },
    });
    const byAchievementId = new Map(unlocked.map((r) => [r.achievementId, r]));
    return {
      enabled: settings?.achievementEnabled ?? true,
      list: this.defs.map((def) => {
        const row = byAchievementId.get(def.id);
        return {
          code: def.code,
          name: def.name,
          rewardFen: def.rewardFen,
          unlocked: !!row,
          claimed: row?.claimed ?? false,
          unlockedAt: row?.unlockedAt ? new Date(row.unlockedAt).toISOString() : null,
        };
      }),
    };
  }

  /**
   * POST /api/achievements/:id/claim（文档 6.3 未列此接口 —— 文档外补充，注释标注）。
   * :id = 成就 code；幂等：(user_id, achievement_id) 唯一约束 + claimed 标志 +
   * fund_flows.idem_key = ach:{userId}:{code}，重复 claim 返回已领取。
   * 成就总开关 off 时亦可领取（口径 f：off 仅影响弹窗与展示，后台记录照常有效）。
   */
  async claim(userId: number, code: string): Promise<ClaimAchievementView> {
    return runInTransaction(this.dataSource, async (manager) => {
      const def = this.defs.find((d) => d.code === code);
      if (!def) throw new BadRequestException('成就不存在');
      const row = await manager.findOne(UserAchievement, {
        where: { userId, achievementId: def.id },
      });
      if (!row) throw new BadRequestException('成就未解锁，不可领取');
      const idemKey = `ach:${userId}:${def.code}`;
      // 幂等回放：金额/余额一律取 fund_flows 既有行（任务 E 钦定：不以 config 现值回放，
      // 防日后改 economy.json 后回放响应与实发流水不一致）
      const replay = await manager.findOne(FundFlow, { where: { idemKey } });
      if (replay) {
        return {
          code,
          rewardFen: replay.amount,
          balanceFen: replay.balanceAfter,
          alreadyClaimed: true,
        };
      }
      if (row.claimed) {
        // 理论不可达（claimed=true 必有对应流水）；防御分支：避免标记与流水脱节时重复入账
        throw new BadRequestException('奖励已领取但流水缺失，请联系管理员');
      }
      const balanceFen = await this.walletService.adjustBalance(manager, {
        userId,
        delta: def.rewardFen,
        type: FundFlowType.Achievement,
        refId: String(row.id),
        idemKey,
      });
      await manager.update(UserAchievement, { id: row.id }, { claimed: true });
      return { code, rewardFen: def.rewardFen, balanceFen, alreadyClaimed: false };
    });
  }
}
