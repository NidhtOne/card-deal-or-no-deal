/**
 * 对局核心引擎 —— 公共类型定义。
 * 纯 TypeScript 模块：本目录禁止任何 I/O、框架依赖、语言内建随机源与时间源（复现性要求，
 * 见 docs/开发文档.md 七章与任务书）；一切随机性经注入的 RngStream 流转。
 */
import type { AleaState } from './rng';

/** 对局状态机状态（docs/开发文档.md 3.6.3）。
 *  REVEAL / TAX 为指令执行内经过的瞬态（无玩家输入），引擎不停留；
 *  其余状态为等待指令的驻留态，SETTLE 为终态。 */
export enum GameStatus {
  PickOwnCard = 'PICK_OWN_CARD',
  FlipRound = 'FLIP_ROUND_N',
  BankerOffer = 'BANKER_OFFER',
  FinalOffer = 'FINAL_OFFER',
  SwapDecision = 'SWAP_DECISION',
  Reveal = 'REVEAL',
  Tax = 'TAX',
  Settle = 'SETTLE',
}

/** 报价阶段（docs/开发文档.md 3.6.4 的前/中/终局；轮次划分为文档外补充，见 config 注释） */
export type OfferPhase = 'early' | 'mid' | 'final';

/** 档位配置（解析后；金额单位：分，INTEGER，铁律 4） */
export interface TierConfig {
  id: string;
  name: string;
  /** 入场费（分）。引擎不扣费，仅在结算时用于计算单局盈利（任务书范围边界） */
  entryFeeFen: number;
  /** 单局最高奖金（分） */
  maxPrizeFen: number;
  /** 26 档基础金额模板（分，升序、唯一、>0、≤ maxPrizeFen） */
  amountsFen: number[];
  /** 与 amountsFen 对齐的扰动权重（>0） */
  weights: number[];
}

/** 报价系数 k 的取值区间 */
export interface KRange {
  min: number;
  max: number;
}

/** 还价判定参数（docs/开发文档.md 3.6.5） */
export interface CounterConfig {
  acceptRatio: number; // 0.85：还价 ≤ EV×acceptRatio 必接受
  probHi: number; // 0.9：区间下沿（恰 0.85EV）处的接受概率
  probLo: number; // 0.3：区间上沿（恰 EV）处的接受概率
}

/** tiers.json 公共节（解析后） */
export interface CommonConfig {
  /** 轮次翻牌序列（3.6.3 固定 [6,5,4,3,2]，之后每轮 1 张由引擎补） */
  flipSequence: number[];
  /** 卡池扰动幅度（文档外补充，算法合同见 pool.ts） */
  poolJitter: number;
  kRanges: Record<OfferPhase, KRange>;
  /** 文档外补充：第 1..earlyMaxRound 轮=前期，..midMaxRound 轮=中期，其后及 FINAL_OFFER=终局 */
  kPhaseRounds: { earlyMaxRound: number; midMaxRound: number };
  counter: CounterConfig;
  /** 小额锚点（分）：3.6.2 的 0.01/0.1/1/10/50 元；每档模板必须包含，生成时固定不扰动 */
  anchorAmountsFen: number[];
}

/** tiers.json 解析结果（金额已转分） */
export interface TiersConfig {
  tiers: Record<string, TierConfig>;
  tierOrder: string[];
  common: CommonConfig;
}

/** 阶梯税配置（AGENTS.md 铁律 8 修正版；金额单位：分） */
export interface TaxConfig {
  /** 起征点（分），作用于单局盈利 */
  thresholdFen: number;
  /** 应税金额级距上限（分，严格递增），长度 = ratesBp.length - 1 */
  bracketsFen: number[];
  /** 税率（万分之一基点的整数，严格递增），长度 = bracketsFen.length + 1 */
  ratesBp: number[];
}

/** economy.json 解析结果（引擎只消费 tax；signin/tasks/bailout/achievements 预留后续阶段） */
export interface EconomyConfig {
  tax: TaxConfig;
}

/** 银行家报价（含终局报价；字段全部进事件日志，供审计复现） */
export interface OfferState {
  /** 常规轮次为 1 起轮号；终局报价为 null */
  round: number | null;
  isFinal: boolean;
  phase: OfferPhase;
  /** 剩余卡（含底牌）均值，浮点中间量，仅供审计 */
  evFen: number;
  /** 当轮区间内抽得的报价系数 */
  k: number;
  /** 最终报价（分，向下取整，非负、≤ EV、≤ 档位上限） */
  offerFen: number;
}

/** 结算结果（SETTLE 后存在） */
export interface Settlement {
  reason: SettleReason;
  /** 税前奖金（分） */
  prizeFen: number;
  /** 单局盈利 = 税前奖金 − 入场费（分，可为负） */
  profitFen: number;
  /** 阶梯税（分） */
  taxFen: number;
  /** 实际到手 = 税前奖金 − 税（分，3.6.7） */
  netFen: number;
}

export type SettleReason = 'deal' | 'counter' | 'keep' | 'swap';

interface EventBase {
  /** 递增逻辑序号（1 起）。引擎内禁止时间戳，持久化时由服务端附加 */
  seq: number;
  /** 超时托管期间产生的事件为 true（规则四.5.3），手动操作恒为 false */
  timeout: boolean;
}

export interface GameCreatedEvent extends EventBase {
  type: 'game_created';
  tierId: string;
  /** 首条事件写入 seed（规则四.5.2：可复现性锚点） */
  seed: string;
  entryFeeFen: number;
  maxPrizeFen: number;
}

export interface PoolGeneratedEvent extends EventBase {
  type: 'pool_generated';
  /** 洗牌后 26 张金额（分），下标即牌位 */
  poolFen: number[];
}

export interface OwnCardPickedEvent extends EventBase {
  type: 'own_card_picked';
  index: number;
}

export interface CardsFlippedEvent extends EventBase {
  type: 'cards_flipped';
  round: number;
  positions: number[];
  amountsFen: number[];
}

export interface OfferMadeEvent extends EventBase {
  type: 'offer_made';
  round: number | null;
  isFinal: boolean;
  phase: OfferPhase;
  evFen: number;
  k: number;
  offerFen: number;
}

export interface OfferResponseEvent extends EventBase {
  type: 'offer_response';
  action: 'deal' | 'no_deal';
  isFinal: boolean;
  offerFen: number;
}

export interface CounterMadeEvent extends EventBase {
  type: 'counter_made';
  isFinal: boolean;
  counterFen: number;
  evFen: number;
  /** 必接受线：EV × acceptRatio（审计用） */
  acceptThresholdFen: number;
  /** 中间分支的接受概率；必接受/必拒分支为 null */
  probability: number | null;
  /** 中间分支的抽签值；未抽签为 null */
  draw: number | null;
  accepted: boolean;
}

export interface SwapDecisionEvent extends EventBase {
  type: 'swap_decision';
  swap: boolean;
}

export interface RevealEvent extends EventBase {
  type: 'reveal';
  ownAmountFen: number;
  publicAmountFen: number;
  /** 仅所选一张为税前奖金，不可相加（3.6.6） */
  prizeFen: number;
}

export interface TaxCalculatedEvent extends EventBase {
  type: 'tax_calculated';
  prizeFen: number;
  entryFeeFen: number;
  profitFen: number;
  taxableFen: number;
  /** 命中税级（1 起）；免税时为 null */
  bracketLevel: number | null;
  taxFen: number;
}

export interface SettledEvent extends EventBase {
  type: 'settled';
  reason: SettleReason;
  prizeFen: number;
  profitFen: number;
  taxFen: number;
  netFen: number;
}

export type GameEvent =
  | GameCreatedEvent
  | PoolGeneratedEvent
  | OwnCardPickedEvent
  | CardsFlippedEvent
  | OfferMadeEvent
  | OfferResponseEvent
  | CounterMadeEvent
  | SwapDecisionEvent
  | RevealEvent
  | TaxCalculatedEvent
  | SettledEvent;

/** getState() 返回的 JSON 可序列化快照（掉线重连恢复与历史回放的全部依据） */
export interface GameSnapshot {
  version: 1;
  tierId: string;
  seed: string;
  status: GameStatus;
  /** 当前轮次（1 起；未进轮次为 0；终局报价阶段保持最后一轮轮号） */
  round: number;
  poolFen: number[];
  ownIndex: number | null;
  /** 按牌位标记是否已淘汰，长度 26 */
  eliminated: boolean[];
  /** 本轮还价机会是否已消耗 */
  counterUsed: boolean;
  currentOffer: OfferState | null;
  rngState: AleaState;
  events: GameEvent[];
  settlement: Settlement | null;
  /** 解析后的配置快照（金额已转分），保证 restore(state) 自洽、无需重传配置 */
  tier: TierConfig;
  common: CommonConfig;
  tax: TaxConfig;
}

/** 玩家对报价的响应：成交 / 拒绝 / 还价（整数分） */
export type OfferResponse = 'deal' | 'noDeal' | { counter: number };

/** 可执行动作（getLegalActions 返回值） */
export type LegalAction =
  'pick_own_card' | 'flip' | 'deal' | 'no_deal' | 'counter' | 'swap_decision' | 'auto_resolve';
