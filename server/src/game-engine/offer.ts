/**
 * 银行家报价与还价判定（docs/开发文档.md 3.6.4/3.6.5、七章.2/3）。纯函数。
 */
import type { RngStream } from './rng';
import type { CommonConfig, CounterConfig, OfferPhase, OfferState } from './types';

/** 剩余卡（含底牌）均值（分，浮点中间量） */
export function meanFen(amountsFen: number[]): number {
  if (amountsFen.length === 0) throw new Error('剩余卡集合为空');
  let sum = 0;
  for (const a of amountsFen) sum += a;
  return sum / amountsFen.length;
}

/**
 * 报价阶段映射（文档外补充决策，知识库未定义前/中/终局的轮次划分）：
 * 第 1..earlyMaxRound 轮 = 前期；..midMaxRound 轮 = 中期；其后轮次与 FINAL_OFFER = 终局。
 */
export function phaseForRound(
  round: number | null,
  isFinal: boolean,
  common: CommonConfig,
): OfferPhase {
  if (isFinal) return 'final';
  if (round === null || !Number.isInteger(round) || round < 1) {
    throw new Error('常规轮次报价必须给出正整数轮号');
  }
  if (round <= common.kPhaseRounds.earlyMaxRound) return 'early';
  if (round <= common.kPhaseRounds.midMaxRound) return 'mid';
  return 'final';
}

/**
 * 银行家报价（3.6.4）：
 * EV = 剩余卡（含底牌）均值；k 在当轮区间内由注入随机流均匀取（k = min + u×(max−min)）；
 * Offer = min(EV×k, 档位上限)，向下取整到分。
 * 配置校验已保证 k ≤ 1，故 Offer ≤ EV×k ≤ EV 恒成立；Offer ≥ 0 且 ≤ 上限。
 */
export function rollOffer(
  remainingFen: number[],
  maxPrizeFen: number,
  common: CommonConfig,
  round: number | null,
  isFinal: boolean,
  rng: RngStream,
): OfferState {
  const evFen = meanFen(remainingFen);
  const phase = phaseForRound(round, isFinal, common);
  const range = common.kRanges[phase];
  const k = range.min + rng.next() * (range.max - range.min);
  const offerFen = Math.max(0, Math.floor(Math.min(evFen * k, maxPrizeFen)));
  return { round, isFinal, phase, evFen, k, offerFen };
}

export interface CounterOutcome {
  accepted: boolean;
  /** 中间分支的接受概率；必接受/必拒分支为 null */
  probability: number | null;
  /** 中间分支的抽签值；未抽签为 null */
  draw: number | null;
}

/**
 * 还价接受判定（3.6.5，公式钉死）：
 * - 还价 ≤ EV×acceptRatio（0.85）→ 必接受（不消耗随机流）；
 * - 还价 > EV → 必拒（不消耗随机流）；
 * - 区间 (acceptRatio×EV, EV] 内：
 *   P(x) = probHi − (probHi − probLo) × (x − acceptRatio×EV) / ((1 − acceptRatio)×EV)，
 *   draw = rng.next()，draw < P 接受。
 *   文档外补充解读：3.6.5 原文「P=(EV−还价)/(0.15×EV) 映射到 90%→30%」按此线性插值理解——
 *   x = 0.85EV 时 P = probHi = 0.9，x = EV 时 P = probLo = 0.3，代入配置即与原文公式一致。
 */
export function evaluateCounter(
  counterFen: number,
  evFen: number,
  counter: CounterConfig,
  rng: RngStream,
): CounterOutcome {
  const threshold = evFen * counter.acceptRatio;
  if (counterFen <= threshold) return { accepted: true, probability: 1, draw: null };
  if (counterFen > evFen) return { accepted: false, probability: 0, draw: null };
  const span = evFen - threshold; // = (1 − acceptRatio)×EV > 0
  const probability =
    counter.probHi - ((counter.probHi - counter.probLo) * (counterFen - threshold)) / span;
  const draw = rng.next();
  return { accepted: draw < probability, probability, draw };
}

/**
 * 还价合法性（3.6.5）：整数分、0 ≤ 还价 ≤ 档位上限、且 ≥ 剩余卡（含底牌）最低面额。
 * 返回 null 表示合法；否则返回驳回原因（调用方据此抛错，且不计入本轮还价次数）。
 */
export function checkCounterLegal(
  counterFen: number,
  remainingFen: number[],
  maxPrizeFen: number,
): string | null {
  if (!Number.isInteger(counterFen)) return '还价金额必须是整数分';
  if (remainingFen.length === 0) return '剩余卡集合为空';
  const minRemain = Math.min(...remainingFen);
  if (counterFen < minRemain) {
    return `还价不得低于场上剩余卡最低面额（${minRemain} 分）`;
  }
  if (counterFen > maxPrizeFen) {
    return `还价不得超过档位上限（${maxPrizeFen} 分）`;
  }
  return null;
}
