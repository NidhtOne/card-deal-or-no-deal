/**
 * 对局核心引擎（状态机 + 事件日志 + 快照恢复）。
 * 范围边界（任务书 0）：引擎只做对局逻辑与结算数值——不扣入场费、不碰钱包、不持久化、
 * 不校验档位解锁（3.6.1 以开局瞬间资金为准，属服务端接线阶段职责）；不提供任何弃权指令
 * （规则四.5.4）。入场费仅作为 tier 配置输入，用于结算时计算单局盈利。
 * 服务端权威（铁律 3）：卡池、报价、还价判定、结算全部由本引擎生成。
 */
import { ConfigError, POOL_SIZE, parseEconomyConfig, parseTiersConfig } from './config';
import { checkCounterLegal, evaluateCounter, rollOffer } from './offer';
import { generatePoolFen } from './pool';
import { createAlea, type RngStream } from './rng';
import { calcTaxFen } from './tax';
import { GameStatus } from './types';
import type {
  CommonConfig,
  GameEvent,
  GameSnapshot,
  LegalAction,
  OfferResponse,
  OfferState,
  SettleReason,
  Settlement,
  TaxConfig,
  TierConfig,
} from './types';

/** 非法操作/非法输入错误（状态机转移校验、参数驳回统一走它） */
export class GameRuleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GameRuleError';
    this.code = code;
  }
}

export interface CreateGameOptions {
  tierId: string;
  seed: string;
  /** tiers.json 原始 JSON（引擎内解析校验并转分，非法抛 ConfigError） */
  tiersConfig: unknown;
  /** economy.json 原始 JSON（同上） */
  economyConfig: unknown;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** 事件输入：seq 与 timeout 由引擎统一附加 */
type GameEventInput = DistributiveOmit<GameEvent, 'seq' | 'timeout'>;

export class GameEngine {
  private status: GameStatus;
  private round: number;
  private ownIndex: number | null;
  private eliminated: boolean[];
  private counterUsed: boolean;
  private currentOffer: OfferState | null;
  private settlement: Settlement | null;
  private readonly events: GameEvent[];
  /** 超时托管模式：进入后产生的事件一律打 timeout=true（规则四.5.3） */
  private timeoutMode: boolean;

  private constructor(
    private readonly tierId: string,
    private readonly seed: string,
    private readonly tier: TierConfig,
    private readonly common: CommonConfig,
    private readonly tax: TaxConfig,
    private readonly poolFen: number[],
    private readonly rng: RngStream,
  ) {
    this.status = GameStatus.PickOwnCard;
    this.round = 0;
    this.ownIndex = null;
    this.eliminated = new Array(POOL_SIZE).fill(false);
    this.counterUsed = false;
    this.currentOffer = null;
    this.settlement = null;
    this.events = [];
    this.timeoutMode = false;
  }

  /** 创建对局：解析校验配置 → 注入随机流生成卡池 → 写入 seed 首条事件 */
  static create(options: CreateGameOptions): GameEngine {
    const tiersConfig = parseTiersConfig(options.tiersConfig);
    const economyConfig = parseEconomyConfig(options.economyConfig);
    const tier = tiersConfig.tiers[options.tierId];
    if (!tier) {
      throw new ConfigError(`未知档位 id：${options.tierId}`);
    }
    const rng = createAlea(options.seed);
    const poolFen = generatePoolFen(tier, tiersConfig.common, rng);
    const engine = new GameEngine(
      options.tierId,
      options.seed,
      tier,
      tiersConfig.common,
      economyConfig.tax,
      poolFen,
      rng,
    );
    engine.emit({
      type: 'game_created',
      tierId: options.tierId,
      seed: options.seed,
      entryFeeFen: tier.entryFeeFen,
      maxPrizeFen: tier.maxPrizeFen,
    });
    engine.emit({ type: 'pool_generated', poolFen: poolFen.slice() });
    return engine;
  }

  /** 从 getState() 快照恢复（掉线重连/历史回放）。快照内嵌配置与随机流状态，自洽恢复 */
  static restore(snapshot: GameSnapshot): GameEngine {
    // 先整体深拷贝隔离外部引用，再做形状校验
    const snap = structuredClone(snapshot);
    if (!snap || typeof snap !== 'object') {
      throw new GameRuleError('BAD_SNAPSHOT', '快照必须是对象');
    }
    if (snap.version !== 1) {
      throw new GameRuleError('BAD_SNAPSHOT', `不支持的快照版本：${String(snap.version)}`);
    }
    if (typeof snap.seed !== 'string' || typeof snap.tierId !== 'string') {
      throw new GameRuleError('BAD_SNAPSHOT', '快照缺少 seed/tierId');
    }
    if (!Object.values(GameStatus).includes(snap.status)) {
      throw new GameRuleError('BAD_SNAPSHOT', `快照含未知状态：${String(snap.status)}`);
    }
    if (!Array.isArray(snap.poolFen) || snap.poolFen.length !== POOL_SIZE) {
      throw new GameRuleError('BAD_SNAPSHOT', `快照卡池必须是 ${POOL_SIZE} 张`);
    }
    if (!Array.isArray(snap.eliminated) || snap.eliminated.length !== POOL_SIZE) {
      throw new GameRuleError('BAD_SNAPSHOT', `快照淘汰标记必须是 ${POOL_SIZE} 位`);
    }
    if (!Array.isArray(snap.events)) {
      throw new GameRuleError('BAD_SNAPSHOT', '快照缺少事件日志');
    }
    const engine = new GameEngine(
      snap.tierId,
      snap.seed,
      snap.tier,
      snap.common,
      snap.tax,
      snap.poolFen,
      createAlea('', snap.rngState),
    );
    engine.status = snap.status;
    engine.round = snap.round;
    engine.ownIndex = snap.ownIndex;
    engine.eliminated = snap.eliminated;
    engine.counterUsed = snap.counterUsed;
    engine.currentOffer = snap.currentOffer;
    engine.settlement = snap.settlement;
    engine.events.push(...snap.events);
    // 已托管过的对局必定已结算；此赋值仅为语义完整
    engine.timeoutMode = snap.events.some((e) => e.timeout);
    return engine;
  }

  // ---------- 查询 ----------

  /** JSON 可序列化快照（掉线重连恢复与历史回放的全部依据） */
  getState(): GameSnapshot {
    return structuredClone({
      version: 1 as const,
      tierId: this.tierId,
      seed: this.seed,
      status: this.status,
      round: this.round,
      poolFen: this.poolFen,
      ownIndex: this.ownIndex,
      eliminated: this.eliminated,
      counterUsed: this.counterUsed,
      currentOffer: this.currentOffer,
      rngState: this.rng.getState(),
      events: this.events,
      settlement: this.settlement,
      tier: this.tier,
      common: this.common,
      tax: this.tax,
    });
  }

  getLegalActions(): LegalAction[] {
    switch (this.status) {
      case GameStatus.PickOwnCard:
        return ['pick_own_card', 'auto_resolve'];
      case GameStatus.FlipRound:
        return ['flip', 'auto_resolve'];
      case GameStatus.BankerOffer:
      case GameStatus.FinalOffer:
        return this.counterUsed
          ? ['deal', 'no_deal', 'auto_resolve']
          : ['deal', 'no_deal', 'counter', 'auto_resolve'];
      case GameStatus.SwapDecision:
        return ['swap_decision', 'auto_resolve'];
      default:
        return [];
    }
  }

  // ---------- 命令（每个返回追加的事件数组） ----------

  pickOwnCard(index: number): GameEvent[] {
    this.assertStatus(GameStatus.PickOwnCard);
    if (!Number.isInteger(index) || index < 0 || index >= POOL_SIZE) {
      throw new GameRuleError('BAD_CARD_INDEX', `底牌序号必须是 [0, ${POOL_SIZE}) 的整数`);
    }
    const events: GameEvent[] = [];
    events.push(this.emit({ type: 'own_card_picked', index }));
    this.ownIndex = index;
    this.round = 1;
    this.counterUsed = false;
    this.status = GameStatus.FlipRound;
    return events;
  }

  flipCurrentRound(): GameEvent[] {
    this.assertStatus(GameStatus.FlipRound);
    const events: GameEvent[] = [];
    // 3.6.3：序列内取配置值，超出序列每轮 1 张；钳制保证翻后总剩余 ≥ 2（含底牌）
    const configured = this.common.flipSequence[this.round - 1] ?? 1;
    const publicPositions = this.publicRemainingPositions();
    const flipCount = Math.min(configured, publicPositions.length - 1);
    if (flipCount < 1) {
      throw new Error('翻牌数为 0（引擎内部错误：应已进入终局）');
    }
    // 卡池开局已洗牌，牌位即随机；按牌位升序取前 flipCount 张公共牌，无需再消耗随机流
    const flipped = publicPositions.slice(0, flipCount);
    for (const p of flipped) this.eliminated[p] = true;
    events.push(
      this.emit({
        type: 'cards_flipped',
        round: this.round,
        positions: flipped,
        amountsFen: flipped.map((p) => this.poolFen[p]),
      }),
    );
    const offer = rollOffer(
      this.remainingAmountsFen(),
      this.tier.maxPrizeFen,
      this.common,
      this.round,
      false,
      this.rng,
    );
    this.currentOffer = offer;
    this.counterUsed = false; // 新一轮报价：重置还价机会（3.6.5 每轮限 1 次）
    this.status = GameStatus.BankerOffer;
    events.push(this.emit({ type: 'offer_made', ...offer }));
    return events;
  }

  respondOffer(response: OfferResponse): GameEvent[] {
    if (this.status !== GameStatus.BankerOffer && this.status !== GameStatus.FinalOffer) {
      throw new GameRuleError('ILLEGAL_STATE', `当前状态 ${this.status} 不能响应报价`);
    }
    const offer = this.currentOffer;
    if (offer === null) {
      throw new GameRuleError('ILLEGAL_STATE', '当前没有待响应的报价');
    }
    if (response === 'deal') return this.dealInternal(offer);
    if (response === 'noDeal') return this.noDealInternal(offer);
    if (typeof response === 'object' && response !== null && 'counter' in response) {
      return this.counterInternal(offer, (response as { counter: unknown }).counter);
    }
    throw new GameRuleError('BAD_RESPONSE', '报价响应必须是 deal / noDeal / { counter }');
  }

  decideSwap(swap: boolean): GameEvent[] {
    this.assertStatus(GameStatus.SwapDecision);
    if (typeof swap !== 'boolean') {
      throw new GameRuleError('BAD_SWAP', '换牌决策必须是布尔值');
    }
    const events: GameEvent[] = [];
    const ownIndex = this.ownIndex;
    if (ownIndex === null) throw new Error('换牌决策时底牌缺失（引擎内部错误）');
    const publicPositions = this.publicRemainingPositions();
    if (publicPositions.length !== 1) {
      throw new Error('换牌决策要求恰好剩 1 张公共牌（引擎内部错误）');
    }
    const ownAmountFen = this.poolFen[ownIndex];
    const publicAmountFen = this.poolFen[publicPositions[0]];
    // 3.6.6：二选一，只取所选一张为税前奖金，不可相加
    const prizeFen = swap ? publicAmountFen : ownAmountFen;
    events.push(this.emit({ type: 'swap_decision', swap }));
    events.push(this.emit({ type: 'reveal', ownAmountFen, publicAmountFen, prizeFen }));
    events.push(...this.settleInternal(prizeFen, swap ? 'swap' : 'keep'));
    return events;
  }

  /**
   * 超时托管（规则四.5.3、七章.5）：从任意未结算状态起自动按 No Deal 走完全部剩余翻牌，
   * 每轮报价自动拒绝；若进入终局自动拒绝终极报价并固定「保留底牌」；随后计税结算。
   * 期间产生的事件一律标记 timeout=true。5 分钟计时器属服务端职责，不在引擎内。
   * 全程只走注入随机流，同 seed 可复现。
   */
  autoResolve(): GameEvent[] {
    if (this.status === GameStatus.Settle) {
      throw new GameRuleError('ALREADY_SETTLED', '对局已结算，无需托管');
    }
    this.timeoutMode = true;
    const events: GameEvent[] = [];
    // 上方守卫收窄了 this.status 的类型，这里显式还原为完整枚举以驱动循环
    let status = this.status as GameStatus;
    let guard = 0;
    while (status !== GameStatus.Settle) {
      guard += 1;
      if (guard > 500) throw new Error('autoResolve 未收敛（引擎内部错误）');
      switch (status) {
        case GameStatus.PickOwnCard:
          // 托管代选底牌：卡池开局已洗牌，0 号位即均匀随机，不再消耗随机流
          events.push(...this.pickOwnCard(0));
          break;
        case GameStatus.FlipRound:
          events.push(...this.flipCurrentRound());
          break;
        case GameStatus.BankerOffer:
        case GameStatus.FinalOffer: {
          const offer = this.currentOffer;
          if (offer === null) throw new Error('报价缺失（引擎内部错误）');
          events.push(...this.noDealInternal(offer));
          break;
        }
        case GameStatus.SwapDecision:
          // 七章.5 钦定：超时进入终局固定「保留底牌」
          events.push(...this.decideSwap(false));
          break;
        default:
          throw new Error(`autoResolve 遇到非法状态 ${String(status)}`);
      }
      status = this.status as GameStatus;
    }
    return events;
  }

  // ---------- 内部转移 ----------

  private dealInternal(offer: OfferState): GameEvent[] {
    const events: GameEvent[] = [];
    events.push(
      this.emit({
        type: 'offer_response',
        action: 'deal',
        isFinal: offer.isFinal,
        offerFen: offer.offerFen,
      }),
    );
    // DEAL 成交也计税：报价即税前奖金（规则五.1/十一章）
    events.push(...this.settleInternal(offer.offerFen, 'deal'));
    return events;
  }

  private noDealInternal(offer: OfferState): GameEvent[] {
    const events: GameEvent[] = [];
    events.push(
      this.emit({
        type: 'offer_response',
        action: 'no_deal',
        isFinal: offer.isFinal,
        offerFen: offer.offerFen,
      }),
    );
    this.currentOffer = null;
    if (offer.isFinal) {
      // 拒绝终极报价 → 换牌决策（3.6.6）
      this.status = GameStatus.SwapDecision;
      return events;
    }
    if (this.remainingPositions().length > 2) {
      this.round += 1;
      this.status = GameStatus.FlipRound;
      return events;
    }
    // 剩余 = 2 → 终局终极报价（3.6.3）
    const finalOffer = rollOffer(
      this.remainingAmountsFen(),
      this.tier.maxPrizeFen,
      this.common,
      null,
      true,
      this.rng,
    );
    this.currentOffer = finalOffer;
    this.counterUsed = false; // 终局作为独立一轮，还价机会重置（3.6.5）
    this.status = GameStatus.FinalOffer;
    events.push(this.emit({ type: 'offer_made', ...finalOffer }));
    return events;
  }

  private counterInternal(offer: OfferState, counterInput: unknown): GameEvent[] {
    if (this.counterUsed) {
      throw new GameRuleError('COUNTER_EXHAUSTED', '本轮还价机会已用完（3.6.5：每轮限 1 次）');
    }
    // 非法输入直接驳回且不计入本轮还价次数（3.6.5）：全部校验通过才消耗机会
    if (typeof counterInput !== 'number' || !Number.isInteger(counterInput)) {
      throw new GameRuleError('BAD_COUNTER', '还价金额必须是整数（分）');
    }
    const illegal = checkCounterLegal(
      counterInput,
      this.remainingAmountsFen(),
      this.tier.maxPrizeFen,
    );
    if (illegal !== null) {
      throw new GameRuleError('BAD_COUNTER', illegal);
    }
    this.counterUsed = true;
    const outcome = evaluateCounter(counterInput, offer.evFen, this.common.counter, this.rng);
    const events: GameEvent[] = [];
    events.push(
      this.emit({
        type: 'counter_made',
        isFinal: offer.isFinal,
        counterFen: counterInput,
        evFen: offer.evFen,
        acceptThresholdFen: offer.evFen * this.common.counter.acceptRatio,
        probability: outcome.probability,
        draw: outcome.draw,
        accepted: outcome.accepted,
      }),
    );
    if (outcome.accepted) {
      // 还价接受：按还价金额成交（规则四.3），同样计税
      events.push(...this.settleInternal(counterInput, 'counter'));
    }
    // 还价失败：保留原报价、停留在报价态、不扣资金（规则四.3），玩家可再 DEAL/NO_DEAL
    return events;
  }

  /** 计税 + 结算（经过瞬态 TAX，无玩家输入，在指令内完成） */
  private settleInternal(prizeFen: number, reason: SettleReason): GameEvent[] {
    const profitFen = prizeFen - this.tier.entryFeeFen; // 单局盈利（铁律 8：可为负，负则免税）
    const taxResult = calcTaxFen(profitFen, this.tax);
    const netFen = prizeFen - taxResult.taxFen;
    const events: GameEvent[] = [];
    events.push(
      this.emit({
        type: 'tax_calculated',
        prizeFen,
        entryFeeFen: this.tier.entryFeeFen,
        profitFen,
        taxableFen: taxResult.taxableFen,
        bracketLevel: taxResult.bracketLevel,
        taxFen: taxResult.taxFen,
      }),
    );
    this.settlement = { reason, prizeFen, profitFen, taxFen: taxResult.taxFen, netFen };
    this.currentOffer = null;
    this.status = GameStatus.Settle;
    events.push(
      this.emit({
        type: 'settled',
        reason,
        prizeFen,
        profitFen,
        taxFen: taxResult.taxFen,
        netFen,
      }),
    );
    return events;
  }

  // ---------- 工具 ----------

  private assertStatus(expected: GameStatus): void {
    if (this.status !== expected) {
      throw new GameRuleError(
        'ILLEGAL_STATE',
        `当前状态 ${this.status} 不允许该操作（需要 ${expected}）`,
      );
    }
  }

  private emit(input: GameEventInput): GameEvent {
    const event = {
      ...input,
      seq: this.events.length + 1,
      timeout: this.timeoutMode,
    } as GameEvent;
    this.events.push(event);
    return event;
  }

  /** 剩余牌位（未淘汰，含底牌） */
  private remainingPositions(): number[] {
    const out: number[] = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      if (!this.eliminated[i]) out.push(i);
    }
    return out;
  }

  /** 剩余公共牌位（未淘汰且非底牌） */
  private publicRemainingPositions(): number[] {
    return this.remainingPositions().filter((p) => p !== this.ownIndex);
  }

  /** 剩余金额（含底牌，报价 EV 的输入） */
  private remainingAmountsFen(): number[] {
    return this.remainingPositions().map((p) => this.poolFen[p]);
  }
}
