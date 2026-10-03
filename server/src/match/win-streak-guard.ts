import { calcTaxFen, type TaxConfig } from '../game-engine';
import type { WinStreakGuardConfig } from '../config/economy';

/**
 * 连胜盈利冻结机制（win_streak_guard）—— 单局结算的纯函数状态机。
 * 【文档外补充：2026-10-03 人工决策落地】全部为文档外新增规则。
 *
 * 决策原文口径：
 * - 触发基数 = 连续单局净盈利累计达到特定水平（trigger_profit_fen，税后净利累计）；
 * - 冻结行为 C = 赢钱可入账但上限锁死、超出部分作废、只保留特定百分比利润；
 * - 解冻 = 输一局解除 + 定时重置（reset_hours 自触发时刻起算）；
 * - 状态全部持久化在 user_game_state（重启不丢），禁用内存态。
 *
 * 结算顺序（任务书 §8 钦定，注释标注待人工过目）：
 * a. P = 税前规则利润（奖金 − 入场费，既有口径，不动）；
 * b. 定时解冻判定在截断之前：到期先解冻，本局（到期后的第一局）不截断
 *    【口径钦定：reset_hours 自触发时刻起算、判定点=结算时】；
 * c. 冻结中且 P > 0：kept = min(floor(P × keep_ratio_bp ÷ 10000), cap_fen)，
 *    作废部分 = P − kept，不写任何 fund_flows 流水（未发放即不存在）
 *    【口径钦定·注释标注待人工过目】；P ≤ 0：不截断，kept = P；
 * d. 税按 kept（截断后）计税【口径钦定：税基=截断后金额，待人工过目】，
 *    net_profit = kept − tax；
 * e. 计数器：net_profit > 0 → win_streak+1、streak_profit+=net_profit；
 *    < 0 → 清零并解除冻结（输一局解除）；= 0 保本 → 全部不变
 *    【沿用 M4 口径 d「保本不中断不计入」】；
 * f. 触发判定（结算落账后）：未冻结且 streak_profit ≥ trigger → 冻结，
 *    triggered_at = now，对下一局生效（本局不截断）【口径钦定，待人工过目】；
 * g. total_settled_games += 1（含托管局）。
 *
 * 金额全程整数运算（铁律 4）；本模块不 import 任何 I/O / NestJS（纯函数，独立单测）。
 */

/** 结算前的用户状态快照（user_game_state 行，或新用户默认值） */
export interface GuardUserState {
  winStreak: number;
  streakProfitFen: number;
  guardFrozen: number;
  guardTriggeredAt: number | null;
  totalSettledGames: number;
}

export interface SettleGuardInput {
  /** 结算时刻（epoch 毫秒） */
  now: number;
  /** 税前规则利润 P = 奖金 − 入场费（分，既有口径） */
  profitFen: number;
  /** 引擎按 P 计出的既有税额（分；功能关闭时直接沿用，保证零改动） */
  engineTaxFen: number;
  /** 入场费（分；= 奖金流水「入场回收 + kept」的回充基数） */
  entryFeeFen: number;
  /** 结算前用户状态 */
  state: GuardUserState;
  /** 冻结机制配置（enabled=false 时为关闭态对象） */
  guard: WinStreakGuardConfig;
  /** 阶梯税配置（重算截断后税额用；起征点/级距/税率不动，铁律 8） */
  tax: TaxConfig;
}

export interface SettleGuardResult {
  /** 奖金流水金额（分）= 入场费 + kept（作废部分不发放、不写流水） */
  bonusDeltaFen: number;
  /** 税额（分；截断时按 kept 重算） */
  taxFen: number;
  /** 截断后入账利润（分；= bonusDeltaFen − entryFeeFen） */
  keptProfitFen: number;
  /** 作废利润（分；= P − kept，无截断为 0） */
  forfeitedFen: number;
  /** 落库净盈亏 = kept − tax（分） */
  netProfitFen: number;
  /** 结算后的计数器状态（整体写回 user_game_state） */
  nextState: GuardUserState;
  /** 本局是否被截断（true = 冻结生效中的盈利局） */
  truncated: boolean;
}

/** 默认状态（新用户无行时） */
export function defaultGuardUserState(): GuardUserState {
  return {
    winStreak: 0,
    streakProfitFen: 0,
    guardFrozen: 0,
    guardTriggeredAt: null,
    totalSettledGames: 0,
  };
}

export function resolveSettleWithGuard(input: SettleGuardInput): SettleGuardResult {
  const { now, profitFen, engineTaxFen, entryFeeFen, state, guard, tax } = input;
  const enabled = guard.enabled;
  const cfg = enabled
    ? {
        triggerProfitFen: guard.triggerProfitFen!,
        keepRatioBp: guard.keepRatioBp!,
        capFen: guard.capFen!,
        resetMs: guard.resetHours! * 3600 * 1000,
      }
    : null;

  // b（前置）：定时解冻判定（冻结中才查；到期先解冻，本局不截断）
  let frozen = state.guardFrozen === 1;
  let triggeredAt = state.guardTriggeredAt;
  if (
    enabled &&
    frozen &&
    triggeredAt !== null &&
    now - triggeredAt >= cfg!.resetMs
  ) {
    frozen = false;
    triggeredAt = null;
  }

  // c：截断（仅冻结中且 P > 0）；否则 kept = P、税沿用引擎值（功能关闭=零改动）
  let keptProfitFen = profitFen;
  let taxFen = engineTaxFen;
  let truncated = false;
  if (enabled && frozen && profitFen > 0) {
    keptProfitFen = Math.min(
      Math.floor((profitFen * cfg!.keepRatioBp) / 10000),
      cfg!.capFen,
    );
    taxFen = calcTaxFen(keptProfitFen, tax).taxFen; // 税基 = 截断后金额
    truncated = true;
  }
  const forfeitedFen = profitFen - keptProfitFen; // 作废部分（不写流水）
  const bonusDeltaFen = entryFeeFen + keptProfitFen; // 奖金流水 = 入场回收 + kept
  const netProfitFen = keptProfitFen - taxFen;

  // d/e：计数器更新（保本不变；亏损清零并解除冻结）
  let winStreak = state.winStreak;
  let streakProfitFen = state.streakProfitFen;
  if (netProfitFen > 0) {
    winStreak += 1;
    streakProfitFen += netProfitFen;
  } else if (netProfitFen < 0) {
    winStreak = 0;
    streakProfitFen = 0;
    frozen = false; // 输一局解除（决策原文）
    triggeredAt = null;
  }
  const totalSettledGames = state.totalSettledGames + 1;

  // f：触发判定（结算落账后；未冻结且累计达标 → 冻结，对下一局生效）
  if (enabled && !frozen && streakProfitFen >= cfg!.triggerProfitFen) {
    frozen = true;
    triggeredAt = now;
  }

  return {
    bonusDeltaFen,
    taxFen,
    keptProfitFen,
    forfeitedFen,
    netProfitFen,
    nextState: {
      winStreak,
      streakProfitFen,
      guardFrozen: frozen ? 1 : 0,
      guardTriggeredAt: triggeredAt,
      totalSettledGames,
    },
    truncated,
  };
}
