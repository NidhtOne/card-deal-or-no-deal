import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { CLOCK, type Clock } from './clock';
import { runInTransaction } from '../common/transaction';
import { getGameRawConfigs } from '../config/game-config';
import { FundFlow, FundFlowType } from '../entities/fund-flow.entity';
import { GameCard, GameCardState } from '../entities/game-card.entity';
import { GameSession, GameSessionStatus } from '../entities/game-session.entity';
import { Offer, OfferResult } from '../entities/offer.entity';
import { UserSettings } from '../entities/user-settings.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import {
  createGame,
  restoreGame,
  GameRuleError,
  GameStatus,
  parseTiersConfig,
  type GameEngine,
  type GameEvent,
  type GameSnapshot,
} from '../game-engine';
import { WalletService } from '../wallet/wallet.service';
import { buildPlayerView, computeFlipQuota, type PlayerView } from './player-view';
import { tierIdByInt, tierIntById } from './tier-map';

/** 5 分钟无操作超时（3.6.8 / 七章.5，文档钦定值） */
const TIMEOUT_MS = 5 * 60 * 1000;
/** 剩余 60 秒提醒（6.4 timeout_warning，文档钦定值） */
const WARNING_MS = 60 * 1000;
/** 进程内超时扫描间隔（七章.5：进程内定时器即可） */
const SCAN_INTERVAL_MS = 1000;

/** 已有进行中对局（单一活跃对局约束：文档外补充，待人工确认） */
export class ActiveSessionExistsError extends ConflictException {
  constructor(public readonly activeSessionId: number) {
    super({ message: '已有进行中的对局', sessionId: activeSessionId });
  }
}

/** 进行中对局的进程内状态 */
interface ActiveSession {
  userId: number;
  engine: GameEngine;
  /** 内存权威截止时间（心跳只更新内存不写库 —— 任务书 §3 折衷，重启丢失心跳延长，偏安全方向） */
  timeoutDeadlineMs: number;
  /** timeout_warning 每会话去重只发一次（6.4） */
  timeoutWarned: boolean;
}

/**
 * 对局会话生命周期服务（服务端权威，铁律 3）：
 * - 进行中对局存进程内 Map<sessionId, ActiveSession>，每次状态变更后同步写穿
 *   state_snapshot（落库 await 后再响应客户端；SQLite 写极廉价，异步落库的崩溃窗口
 *   会导致玩家已见状态被回滚，违背服务端权威）；
 * - per-session 串行队列：同一会话的 REST 命令、心跳、超时定时器回调一律进入该会话的
 *   Promise 链串行执行，杜绝 deal 与 autoResolve 竞态；
 * - 一切写事务经 runInTransaction（全局 FIFO 互斥，见 common/transaction.ts）；
 * - 对局规则数值一律来自引擎（createGame/restoreGame + 五个命令），本层不重写任何规则。
 */
@Injectable()
export class GameSessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GameSessionService.name);
  private readonly active = new Map<number, ActiveSession>();
  /** per-session 串行队列尾（独立于 active Map，保证恢复前入链也不会丢序） */
  private readonly queues = new Map<number, Promise<unknown>>();
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly walletService: WalletService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * 重启恢复：扫描 status='进行' 的会话 → restoreGame(state_snapshot) → 重建 Map；
   * timeout_deadline 已过（或崩溃窗口下快照已终态但行未结算）的立即 autoResolve 托管。
   * 折衷（注释标注）：心跳只更新内存 deadline 不写库，重启丢失心跳延长时间，偏安全方向。
   */
  async onModuleInit(): Promise<void> {
    const rows = await this.dataSource
      .getRepository(GameSession)
      .find({ where: { status: GameSessionStatus.Playing } });
    const pending: Promise<unknown>[] = [];
    for (const row of rows) {
      try {
        const engine = restoreGame(JSON.parse(row.stateSnapshot) as GameSnapshot);
        this.active.set(row.id, {
          userId: row.userId,
          engine,
          timeoutDeadlineMs: row.timeoutDeadline,
          timeoutWarned: false,
        });
        const settled = engine.getState().status === GameStatus.Settle;
        if (settled || row.timeoutDeadline <= this.clock.now()) {
          pending.push(
            this.enqueue(row.id, () => this.autoResolveAndSettle(row.id)).catch((e) =>
              this.logger.error(`重启托管失败 session=${row.id}`, e as Error),
            ),
          );
        }
      } catch (e) {
        this.logger.error(`对局恢复失败 session=${row.id}（保留行待人工核查）`, e as Error);
      }
    }
    await Promise.all(pending);
    this.scanTimer = setInterval(() => {
      void this.scanTimeouts().catch((e) => this.logger.error('超时扫描失败', e as Error));
    }, SCAN_INTERVAL_MS);
    this.scanTimer.unref();
    this.logger.log(`对局恢复完成：${rows.length} 个进行中对局`);
  }

  onModuleDestroy(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
  }

  // ---------- per-session 串行队列 ----------

  private enqueue<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    // 链尾永不 rejected（失败已吞），前序任务失败不影响后续命令
    const result = prev.then(fn);
    this.queues.set(
      sessionId,
      result.catch(() => undefined),
    );
    return result;
  }

  // ---------- 对局创建（POST /api/match/start） ----------

  /**
   * 开局（6.3）：传 tier（1–5）；解锁校验 = 开局瞬间余额 ≥ 该档 entry_fee
   * （3.6.1，含取款机档；对局中资金变动不影响本局，入会话快照）。
   * 客户端幂等键：fund_flows.idem_key = match:{userId}:start:{clientKey}。
   */
  async start(
    userId: number,
    tier: number,
    clientKey?: string,
  ): Promise<{ sessionId: number; state: PlayerView }> {
    const tierId = tierIdByInt(tier);
    if (!tierId) throw new BadRequestException('档位必须是 1–5 的整数');
    const { tiersRaw, economyRaw } = getGameRawConfigs();
    const tierCfg = parseTiersConfig(tiersRaw).tiers[tierId];
    const idemKey = clientKey ? `match:${userId}:start:${clientKey}` : null;

    // 幂等回放快路径：同一 clientKey 直接返回已建会话
    if (idemKey) {
      const dup = await this.dataSource.getRepository(FundFlow).findOne({ where: { idemKey } });
      if (dup?.refId) {
        const sessionId = Number(dup.refId);
        return { sessionId, state: await this.getStateView(userId, sessionId) };
      }
    }

    const created = await runInTransaction(this.dataSource, async (manager) => {
      // 幂等键事务内复查（并发双击：互斥串行后第二个请求在此命中）
      if (idemKey) {
        const dup = await manager.findOne(FundFlow, { where: { idemKey } });
        if (dup?.refId) return { sessionId: Number(dup.refId), engine: null, deadlineMs: 0 };
      }
      // 单一活跃对局（知识库未定义 —— 文档外补充，待人工确认）：进行中存在则拒绝并回传会话 id
      const playing = await manager.findOne(GameSession, {
        where: { userId, status: GameSessionStatus.Playing },
      });
      if (playing) throw new ActiveSessionExistsError(playing.id);

      // 解锁校验（3.6.1）：开局瞬间余额 ≥ 该档 entry_fee（含取款机档）
      const wallet = await manager.findOne(UserWallet, { where: { userId } });
      if (!wallet || wallet.balance < tierCfg.entryFeeFen) {
        throw new BadRequestException('余额不足，无法进入该档位（3.6.1：开局瞬间余额须 ≥ 入场费）');
      }

      // seed 由服务端生成（crypto.randomBytes(16) hex），禁止客户端传入
      const seed = randomBytes(16).toString('hex');
      const engine = createGame({ tierId, seed, tiersConfig: tiersRaw, economyConfig: economyRaw });
      const snapshot = engine.getState();
      const deadlineMs = this.clock.now() + TIMEOUT_MS;

      // 先建会话拿到 id（adjustBalance 的 ref_id 关联对局，供幂等回放定位）；
      // 同事务原子提交，与「扣费 → 建局」逻辑序等价
      const session = await manager.save(
        GameSession,
        manager.create(GameSession, {
          userId,
          tier,
          entryFee: tierCfg.entryFeeFen,
          tierMaxPrize: tierCfg.maxPrizeFen,
          status: GameSessionStatus.Playing,
          ownCardId: null,
          currentRound: 0,
          flipQuota: 0,
          currentOffer: null,
          counterUsedRound: false,
          timeoutDeadline: deadlineMs,
          stateSnapshot: JSON.stringify(snapshot),
        }),
      );
      // 铁律 1/2：复用 WalletService.adjustBalance 扣入场费（自带余额条件防负 + 幂等）
      await this.walletService.adjustBalance(manager, {
        userId,
        delta: -tierCfg.entryFeeFen,
        type: FundFlowType.Entry,
        refId: String(session.id),
        idemKey,
      });
      // 26 张卡落库（3.6.2）
      await manager.save(
        GameCard,
        snapshot.poolFen.map((amount, position) =>
          manager.create(GameCard, {
            sessionId: session.id,
            position,
            amount,
            state: GameCardState.Public,
            flippedAt: null,
          }),
        ),
      );
      return { sessionId: session.id, engine, deadlineMs };
    });

    if (created.engine) {
      this.active.set(created.sessionId, {
        userId,
        engine: created.engine,
        timeoutDeadlineMs: created.deadlineMs,
        timeoutWarned: false,
      });
      // 七章.6 任务进度钩子（阶段 5 消费；@nestjs/event-emitter —— 文档外补充）
      this.events.emit('match_started', {
        userId,
        sessionId: created.sessionId,
        tier,
        entryFeeFen: tierCfg.entryFeeFen,
      });
    }
    return {
      sessionId: created.sessionId,
      state: await this.getStateView(userId, created.sessionId),
    };
  }

  // ---------- 操作命令（全部服务端校验状态机） ----------

  /** 选定底牌 */
  async pick(userId: number, sessionId: number, index: number): Promise<void> {
    await this.runCommand(sessionId, userId, (engine) => engine.pickOwnCard(index));
  }

  /** 翻开本轮卡牌（引擎内置轮次配额；该命令同步生成本轮报价，是报价唯一生成点） */
  async flip(userId: number, sessionId: number): Promise<void> {
    await this.runCommand(sessionId, userId, (engine) => engine.flipCurrentRound());
  }

  /** 接受报价 → 结算 */
  async deal(userId: number, sessionId: number): Promise<void> {
    await this.runCommand(sessionId, userId, (engine) => engine.respondOffer('deal'));
  }

  /** 还价（整数分；合法性由引擎校验，非法不计入本轮还价次数） */
  async counter(userId: number, sessionId: number, counter: number): Promise<void> {
    await this.runCommand(sessionId, userId, (engine) => engine.respondOffer({ counter }));
  }

  /** 拒绝报价 */
  async noDeal(userId: number, sessionId: number): Promise<void> {
    await this.runCommand(sessionId, userId, (engine) => engine.respondOffer('noDeal'));
  }

  /** 终局换牌决策 */
  async swap(userId: number, sessionId: number, swap: boolean): Promise<void> {
    await this.runCommand(sessionId, userId, (engine) => engine.decideSwap(swap));
  }

  /**
   * 心跳（WS heartbeat，3.6.8）：只重置内存 timeout_deadline = now+5 分钟，不写库
   * （任务书 §3 折衷：重启丢失心跳延长，偏安全方向）。已结束/不存在的心跳静默忽略。
   */
  async heartbeat(sessionId: number, userId: number): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const active = this.active.get(sessionId);
      if (!active || active.userId !== userId) return;
      active.timeoutDeadlineMs = this.clock.now() + TIMEOUT_MS;
    });
  }

  // ---------- 只读查询 ----------

  /** GET state：玩家视图 DTO（脱敏，重连恢复用） */
  async getStateView(userId: number, sessionId: number): Promise<PlayerView> {
    const row = await this.dataSource
      .getRepository(GameSession)
      .findOne({ where: { id: sessionId } });
    if (!row || row.userId !== userId) throw new NotFoundException('对局不存在');
    const active = this.active.get(sessionId);
    const snapshot: GameSnapshot = active
      ? active.engine.getState()
      : (JSON.parse(row.stateSnapshot) as GameSnapshot);
    const deadlineMs = active ? active.timeoutDeadlineMs : row.timeoutDeadline;
    return buildPlayerView(snapshot, row, deadlineMs);
  }

  /** GET offer：只读返回当前 currentOffer（报价唯一生成点在 flip，禁止第二条消耗 RNG 的路径） */
  async getOfferView(
    userId: number,
    sessionId: number,
  ): Promise<{ offer: PlayerView['currentOffer'] }> {
    const view = await this.getStateView(userId, sessionId);
    return { offer: view.currentOffer };
  }

  /**
   * GET amount-list（3.6.2/3.7）：本局 26 张面额多重集合（升序）+ 已淘汰划线标记，
   * 不携带任何位置对应关系；user_settings.amount_list_enabled = false 时返回关闭态。
   * 注：池内金额唯一（引擎保证），淘汰标记按金额标注安全。
   */
  async getAmountList(
    userId: number,
    sessionId: number,
  ): Promise<{ enabled: boolean; amounts: { amountFen: number; eliminated: boolean }[] }> {
    const settings = await this.dataSource
      .getRepository(UserSettings)
      .findOne({ where: { userId } });
    if (settings && !settings.amountListEnabled) {
      return { enabled: false, amounts: [] };
    }
    const row = await this.dataSource
      .getRepository(GameSession)
      .findOne({ where: { id: sessionId } });
    if (!row || row.userId !== userId) throw new NotFoundException('对局不存在');
    const active = this.active.get(sessionId);
    const snapshot: GameSnapshot = active
      ? active.engine.getState()
      : (JSON.parse(row.stateSnapshot) as GameSnapshot);
    const amounts = snapshot.poolFen
      .map((amountFen, i) => ({ amountFen, eliminated: snapshot.eliminated[i] }))
      .sort((a, b) => a.amountFen - b.amountFen);
    return { enabled: true, amounts };
  }

  // ---------- 超时托管（七章.5） ----------

  /** 扫描进行中对局的 timeout_deadline：到期托管、剩余 60 秒预警（每会话一次） */
  async scanTimeouts(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const sessionId of [...this.active.keys()]) {
      tasks.push(
        this.enqueue(sessionId, async () => {
          const active = this.active.get(sessionId);
          if (!active) return;
          const remainMs = active.timeoutDeadlineMs - this.clock.now();
          if (remainMs <= 0) {
            await this.autoResolveAndSettle(sessionId);
          } else if (remainMs <= WARNING_MS && !active.timeoutWarned) {
            active.timeoutWarned = true;
            this.events.emit('timeout_warning', {
              userId: active.userId,
              sessionId,
              remainingSeconds: Math.ceil(remainMs / 1000),
            });
          }
        }),
      );
    }
    await Promise.all(tasks);
  }

  /**
   * 超时托管（七章.5）：autoResolve 自动 No Deal 走完剩余翻牌、终局自动拒绝并固定
   * 「保留底牌」、计税结算（引擎保证），事件流打 timeout=true。
   */
  private async autoResolveAndSettle(sessionId: number): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    let events: GameEvent[];
    try {
      events = active.engine.autoResolve();
    } catch (e) {
      // 崩溃窗口恢复：快照已是终态但行未结算 → 直接补结算（幂等守卫兜底）
      if (e instanceof GameRuleError && e.code === 'ALREADY_SETTLED') {
        await this.settleSession(sessionId);
        return;
      }
      throw e;
    }
    await this.persistEvents(sessionId, active, events);
    this.pushEngineEvents(active.userId, sessionId, events);
    await this.settleSession(sessionId);
  }

  // ---------- 内部：命令执行骨架 ----------

  /** 命令入口：per-session 串行 → 引擎执行 → 写穿落库 → WS 推送 → （若终局）结算 */
  private async runCommand(
    sessionId: number,
    userId: number,
    command: (engine: GameEngine) => GameEvent[],
  ): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const active = await this.getOrRestoreActive(sessionId, userId);
      let events: GameEvent[];
      try {
        events = command(active.engine);
      } catch (e) {
        throw this.toHttpException(e);
      }
      // 每个命令成功后刷新 timeout_deadline（now+5 分钟，内存 + 快照落库同步更新）
      active.timeoutDeadlineMs = this.clock.now() + TIMEOUT_MS;
      await this.persistEvents(sessionId, active, events);
      this.pushEngineEvents(userId, sessionId, events);
      if (events.some((e) => e.type === 'settled')) {
        await this.settleSession(sessionId);
      }
    });
  }

  /** 取进行中对局（内存未命中时从 DB 快照恢复补建，如重启间隙） */
  private async getOrRestoreActive(sessionId: number, userId: number): Promise<ActiveSession> {
    const cached = this.active.get(sessionId);
    if (cached) {
      if (cached.userId !== userId) throw new NotFoundException('对局不存在');
      return cached;
    }
    const row = await this.dataSource
      .getRepository(GameSession)
      .findOne({ where: { id: sessionId } });
    if (!row || row.userId !== userId) throw new NotFoundException('对局不存在');
    if (row.status !== GameSessionStatus.Playing) {
      throw new ConflictException('对局已结束');
    }
    const engine = restoreGame(JSON.parse(row.stateSnapshot) as GameSnapshot);
    const active: ActiveSession = {
      userId,
      engine,
      timeoutDeadlineMs: row.timeoutDeadline,
      timeoutWarned: false,
    };
    this.active.set(sessionId, active);
    return active;
  }

  /**
   * 写穿落库（同步 await 后再响应）：引擎事件 → offers/game_cards →
   * game_sessions 冗余列 + state_snapshot + timeout_deadline。
   */
  private async persistEvents(
    sessionId: number,
    active: ActiveSession,
    events: GameEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const snapshot = active.engine.getState();
    await runInTransaction(this.dataSource, async (manager) => {
      for (const e of events) {
        if (e.type === 'offer_made') {
          await manager.insert(Offer, {
            sessionId,
            round: e.round,
            offerAmount: e.offerFen,
            result: null,
            k: e.k,
            evFen: e.evFen,
          });
        } else if (e.type === 'offer_response') {
          await this.updateLatestOffer(manager, sessionId, {
            result:
              e.action === 'deal'
                ? OfferResult.Deal
                : e.timeout
                  ? OfferResult.Timeout
                  : OfferResult.Rejected,
          });
        } else if (e.type === 'counter_made') {
          await this.updateLatestOffer(manager, sessionId, {
            counterAmount: e.counterFen,
            counterDraw: e.draw,
            counterProbability: e.probability,
            result: e.accepted ? OfferResult.CounterAccepted : OfferResult.CounterRejected,
          });
        } else if (e.type === 'cards_flipped') {
          await manager
            .createQueryBuilder()
            .update(GameCard)
            .set({ state: GameCardState.Eliminated, flippedAt: new Date(this.clock.now()) })
            .where('session_id = :sid AND position IN (:...positions)', {
              sid: sessionId,
              positions: e.positions,
            })
            .execute();
        } else if (e.type === 'own_card_picked') {
          await manager.update(
            GameCard,
            { sessionId, position: e.index },
            { state: GameCardState.Own },
          );
        }
      }
      await manager.update(GameSession, { id: sessionId }, {
        ownCardId: snapshot.ownIndex,
        currentRound: snapshot.round,
        flipQuota: computeFlipQuota(snapshot),
        currentOffer: snapshot.currentOffer ? snapshot.currentOffer.offerFen : null,
        counterUsedRound: snapshot.counterUsed,
        timeoutDeadline: active.timeoutDeadlineMs,
        stateSnapshot: JSON.stringify(snapshot),
      });
    });
  }

  /** 更新当前待响应报价行（同会话 id 序即时间序，最大 id 即当前报价） */
  private async updateLatestOffer(
    manager: EntityManager,
    sessionId: number,
    patch: Partial<Offer>,
  ): Promise<void> {
    const row = await manager.findOne(Offer, { where: { sessionId }, order: { id: 'DESC' } });
    if (!row) throw new Error(`offers 行缺失（session=${sessionId}，内部错误）`);
    await manager.update(Offer, { id: row.id }, patch);
  }

  /**
   * 结算（幂等，铁律 1/2）：守卫 UPDATE ... WHERE status='进行'，影响行数=0 即已结算，
   * 直接返回既有结果，余额只变一次、offers 不重复行。
   * 提交后发出 match_settled 内部事件（七章.6 成就判定钩子，阶段 5 消费，文档外补充）。
   */
  private async settleSession(sessionId: number): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) return;
    const snapshot = active.engine.getState();
    const settlement = snapshot.settlement;
    if (!settlement) throw new Error('结算缺失（引擎内部错误）');
    const settledEvent = [...snapshot.events].reverse().find((e) => e.type === 'settled');
    const isTimeout = settledEvent && 'timeout' in settledEvent ? settledEvent.timeout : false;
    // 状态映射：deal/counter→成交，keep/swap→终局，timeout→超时结算
    const dbStatus = isTimeout
      ? GameSessionStatus.Timeout
      : settlement.reason === 'deal' || settlement.reason === 'counter'
        ? GameSessionStatus.Deal
        : GameSessionStatus.Final;
    const userId = active.userId;
    const netProfitFen = settlement.netFen - snapshot.tier.entryFeeFen;

    const outcome = await runInTransaction(this.dataSource, async (manager) => {
      const guard = await manager
        .createQueryBuilder()
        .update(GameSession)
        .set({ status: dbStatus, finishedAt: new Date(this.clock.now()) })
        .where('id = :id AND status = :playing', {
          id: sessionId,
          playing: GameSessionStatus.Playing,
        })
        .execute();
      if (!guard.affected) return null; // 已结算：直接返回既有结果

      // 1. 发奖金（幂等键 match:{id}:bonus）
      let balance = await this.walletService.adjustBalance(manager, {
        userId,
        delta: settlement.prizeFen,
        type: FundFlowType.Bonus,
        refId: String(sessionId),
        idemKey: `match:${sessionId}:bonus`,
      });
      // 2. 计税（taxFen=0 时不写税流水）
      if (settlement.taxFen > 0) {
        balance = await this.walletService.adjustBalance(manager, {
          userId,
          delta: -settlement.taxFen,
          type: FundFlowType.Tax,
          refId: String(sessionId),
          idemKey: `match:${sessionId}:tax`,
        });
      }
      // 3. 结算字段 + 终态快照
      await manager.update(GameSession, { id: sessionId }, {
        finalBonus: settlement.prizeFen,
        tax: settlement.taxFen,
        netProfit: netProfitFen,
        settledBalance: balance,
        currentOffer: null,
        flipQuota: 0,
        stateSnapshot: JSON.stringify(snapshot),
      });
      return { settledBalanceFen: balance };
    });

    // 会话终局：移出内存（后续 GET state 走 DB 快照）
    this.active.delete(sessionId);
    this.queues.delete(sessionId);
    if (!outcome) return;

    this.events.emit('match_settled', {
      userId,
      sessionId,
      tier: tierIntById(snapshot.tierId),
      status: dbStatus,
      timeout: isTimeout,
      settlement: {
        reason: settlement.reason,
        prizeFen: settlement.prizeFen,
        profitFen: settlement.profitFen,
        taxFen: settlement.taxFen,
        netFen: settlement.netFen,
      },
      netProfitFen,
      settledBalanceFen: outcome.settledBalanceFen,
    });
  }

  /** 引擎事件 → 进程内事件总线（WS 网关转发；载荷只含玩家视图字段，禁泄牌） */
  private pushEngineEvents(userId: number, sessionId: number, events: GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'cards_flipped') {
        this.events.emit('flip_result', {
          userId,
          sessionId,
          round: e.round,
          positions: e.positions,
          amountsFen: e.amountsFen,
        });
      } else if (e.type === 'offer_made') {
        this.events.emit('offer_ready', {
          userId,
          sessionId,
          offer: {
            round: e.round,
            isFinal: e.isFinal,
            phase: e.phase,
            offerFen: e.offerFen,
          },
        });
      }
    }
  }

  /** 引擎状态机/参数错误 → HTTP（ILLEGAL_STATE/ALREADY_SETTLED → 409，其余 400） */
  private toHttpException(e: unknown): HttpException {
    if (e instanceof GameRuleError) {
      const conflict = e.code === 'ILLEGAL_STATE' || e.code === 'ALREADY_SETTLED';
      return new HttpException({ message: e.message, code: e.code }, conflict ? 409 : 400);
    }
    return e instanceof HttpException ? e : new HttpException('对局内部错误', 500);
  }
}
