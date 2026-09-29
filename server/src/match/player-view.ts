import { GameStatus, type GameSnapshot, type OfferPhase, type SettleReason } from '../game-engine';
import { parseDbDate } from '../common/db-date';
import type { GameSession } from '../entities/game-session.entity';

/**
 * 玩家视图 DTO（脱敏，重连恢复用）。
 * 铁律：禁止下发 state_snapshot、seed、rngState、未翻牌位的金额映射
 * （3.6.2 不揭示位置；下发即泄牌后门）。金额字段一律整数分。
 * 报价只暴露 offerFen/round/isFinal/phase：evFen/k 属浮点审计中间量（offers 表留痕），
 * 不下发玩家视图。
 */
export interface PlayerView {
  sessionId: number;
  /** 档位 1–5（映射见 tier-map.ts） */
  tier: number;
  /** DB 对局状态：进行/成交/终局/超时结算 */
  status: string;
  /** 引擎状态机驻留态（PICK_OWN_CARD / FLIP_ROUND_N / BANKER_OFFER / FINAL_OFFER / SWAP_DECISION / SETTLE） */
  engineStatus: GameStatus;
  /** 当前轮次（1 起；未进轮次为 0） */
  round: number;
  /** 本轮待翻张数（仅翻牌态有意义） */
  flipQuota: number;
  /** 底牌位置（不含金额！） */
  ownCardPosition: number | null;
  /** 已翻牌位与金额（已淘汰公共牌） */
  flippedCards: { position: number; amountFen: number }[];
  /** 剩余张数（含底牌） */
  remainingCount: number;
  /** 当前报价（无待响应报价为 null） */
  currentOffer: {
    round: number | null;
    isFinal: boolean;
    phase: OfferPhase;
    offerFen: number;
  } | null;
  /** 本轮还价机会是否已消耗 */
  counterUsed: boolean;
  /** 超时截止时间（ISO 字符串） */
  timeoutDeadline: string;
  /** 结算结果（已结算时存在） */
  settlement: {
    reason: SettleReason;
    prizeFen: number;
    profitFen: number;
    taxFen: number;
    netFen: number;
  } | null;
  /** 税后入账后的余额快照（分；未结算为 null） */
  settledBalanceFen: number | null;
  /** 实际盈亏 = 税后到手 − 入场费（分；未结算为 null） */
  netProfitFen: number | null;
  entryFeeFen: number;
  tierMaxPrizeFen: number;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 本轮待翻张数（与引擎 flipCurrentRound 的钳制规则一致：翻后总剩余 ≥ 2） */
export function computeFlipQuota(snapshot: GameSnapshot): number {
  if (snapshot.status !== GameStatus.FlipRound) return 0;
  const configured = snapshot.common.flipSequence[snapshot.round - 1] ?? 1;
  let publicRemaining = 0;
  for (let i = 0; i < snapshot.eliminated.length; i++) {
    if (!snapshot.eliminated[i] && i !== snapshot.ownIndex) publicRemaining += 1;
  }
  return Math.max(0, Math.min(configured, publicRemaining - 1));
}

/** 从引擎快照 + DB 行组装玩家视图（服务端机密字段一律不带出） */
export function buildPlayerView(
  snapshot: GameSnapshot,
  row: GameSession,
  timeoutDeadlineMs: number,
): PlayerView {
  const flippedCards: { position: number; amountFen: number }[] = [];
  for (let i = 0; i < snapshot.eliminated.length; i++) {
    if (snapshot.eliminated[i]) {
      flippedCards.push({ position: i, amountFen: snapshot.poolFen[i] });
    }
  }
  return {
    sessionId: row.id,
    tier: row.tier,
    status: row.status,
    engineStatus: snapshot.status,
    round: snapshot.round,
    flipQuota: computeFlipQuota(snapshot),
    ownCardPosition: snapshot.ownIndex,
    flippedCards,
    remainingCount: snapshot.poolFen.length - flippedCards.length,
    currentOffer: snapshot.currentOffer
      ? {
          round: snapshot.currentOffer.round,
          isFinal: snapshot.currentOffer.isFinal,
          phase: snapshot.currentOffer.phase,
          offerFen: snapshot.currentOffer.offerFen,
        }
      : null,
    counterUsed: snapshot.counterUsed,
    timeoutDeadline: new Date(timeoutDeadlineMs).toISOString(),
    settlement: snapshot.settlement
      ? {
          reason: snapshot.settlement.reason,
          prizeFen: snapshot.settlement.prizeFen,
          profitFen: snapshot.settlement.profitFen,
          taxFen: snapshot.settlement.taxFen,
          netFen: snapshot.settlement.netFen,
        }
      : null,
    settledBalanceFen: row.settledBalance ?? null,
    netProfitFen: row.netProfit ?? null,
    entryFeeFen: row.entryFee,
    tierMaxPrizeFen: row.tierMaxPrize,
    startedAt: parseDbDate(row.startedAt)?.toISOString() ?? null,
    finishedAt: parseDbDate(row.finishedAt)?.toISOString() ?? null,
  };
}
