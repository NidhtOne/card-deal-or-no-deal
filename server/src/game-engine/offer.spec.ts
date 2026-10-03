import { checkCounterLegal, evaluateCounter, meanFen, phaseForRound, rollOffer } from './offer';
import { parseTiersConfig } from './config';
import { createAlea, type RngStream } from './rng';
import type { CommonConfig } from './types';

function makeCommon(): CommonConfig {
  const cfg = parseTiersConfig({
    common: {
      flip_sequence: [6, 5, 4, 3, 2],
      anchor_amounts: [0.01, 0.1, 1, 10, 50],
      pool_jitter: 0.25,
      k_ranges: {
        early: { min: 0.55, max: 0.75 },
        mid: { min: 0.65, max: 0.85 },
        final: { min: 0.8, max: 0.95 },
      },
      k_phase_rounds: { early_max_round: 2, mid_max_round: 4 },
      counter: { accept_ratio: 0.85, prob_hi: 0.9, prob_lo: 0.3 },
    },
    tiers: {
      test: {
        name: '测试档',
        entry_fee: 388,
        max_prize: 10000,
        amounts: [
          0.01, 0.1, 1, 10, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1600,
          1800, 2000, 2500, 3000, 4000, 5000, 7500, 10000,
        ],
        weights: Array(26).fill(1),
      },
    },
  });
  return cfg.common;
}

const COMMON = makeCommon();
const COUNTER_CFG = COMMON.counter;

/** 固定输出桩随机流（用于精确命中还价概率分支） */
function stubRng(value: number): RngStream {
  return {
    next: () => value,
    intBelow: () => {
      throw new Error('桩不支持 intBelow');
    },
    getState: () => {
      throw new Error('桩不支持 getState');
    },
  };
}

describe('game-engine/offer：meanFen', () => {
  it('均值计算正确', () => {
    expect(meanFen([1, 2, 3])).toBe(2);
    expect(meanFen([100, 101])).toBe(100.5);
  });

  it('空集合抛错', () => {
    expect(() => meanFen([])).toThrow();
  });
});

describe('game-engine/offer：phaseForRound（文档外补充轮次映射）', () => {
  it('第 1–2 轮=前期、第 3–4 轮=中期、第 5 轮起=终局、FINAL_OFFER=终局', () => {
    expect(phaseForRound(1, false, COMMON)).toBe('early');
    expect(phaseForRound(2, false, COMMON)).toBe('early');
    expect(phaseForRound(3, false, COMMON)).toBe('mid');
    expect(phaseForRound(4, false, COMMON)).toBe('mid');
    expect(phaseForRound(5, false, COMMON)).toBe('final');
    expect(phaseForRound(9, false, COMMON)).toBe('final');
    expect(phaseForRound(null, true, COMMON)).toBe('final');
    expect(phaseForRound(7, true, COMMON)).toBe('final');
  });

  it('非法轮次抛错', () => {
    expect(() => phaseForRound(0, false, COMMON)).toThrow();
    expect(() => phaseForRound(null, false, COMMON)).toThrow();
  });
});

describe('game-engine/offer：rollOffer（3.6.4、七章.2；附录 A：报价 ≤ EV 且 ≤ 档位上限、非负）', () => {
  it('k 在当轮映射区间内均匀取值：k = min + u×(max−min)', () => {
    const remaining = [100, 200, 300, 400];
    // u = 0 → k = min
    const o1 = rollOffer(remaining, 1000000, COMMON, 1, false, stubRng(0));
    expect(o1.k).toBeCloseTo(0.55, 10);
    expect(o1.phase).toBe('early');
    // u = 0.999… → k 接近 max
    const o2 = rollOffer(remaining, 1000000, COMMON, 1, false, stubRng(0.999999));
    expect(o2.k).toBeGreaterThan(0.74);
    expect(o2.k).toBeLessThanOrEqual(0.75);
    // 第 3 轮 mid 区间
    const o3 = rollOffer(remaining, 1000000, COMMON, 3, false, stubRng(0.5));
    expect(o3.k).toBeCloseTo(0.75, 10);
    expect(o3.phase).toBe('mid');
    // 终局 final 区间
    const o4 = rollOffer(remaining, 1000000, COMMON, null, true, stubRng(0.5));
    expect(o4.k).toBeCloseTo(0.875, 10);
    expect(o4.phase).toBe('final');
    expect(o4.isFinal).toBe(true);
    expect(o4.round).toBeNull();
  });

  it('Offer = min(EV×k, 上限) 向下取整：非负、≤EV、≤上限', () => {
    const remaining = [100, 200, 300, 400]; // EV = 250
    // u=0.5 → k=0.65 → 250×0.65=162.5 → 向下取整 162
    const o = rollOffer(remaining, 1000000, COMMON, 1, false, stubRng(0.5));
    expect(o.evFen).toBe(250);
    expect(o.offerFen).toBe(162);
    expect(o.offerFen).toBeLessThanOrEqual(o.evFen);
    expect(o.offerFen).toBeGreaterThanOrEqual(0);
  });

  it('档位上限钳制：EV×k 超过上限时报价 = 上限（仍 ≤EV 时需同时满足，取 min）', () => {
    const remaining = [900000, 950000]; // EV = 925000
    // k = 0.95 → 878750 ≤ 上限 1000000？超过场景：上限取 800000
    const o = rollOffer(remaining, 800000, COMMON, null, true, stubRng(0.999999));
    expect(o.offerFen).toBe(800000);
    expect(o.offerFen).toBeLessThanOrEqual(o.evFen);
  });

  it('大额被淘汰后 EV 下降 → 报价自然走低', () => {
    const rich = [500000, 600000, 700000, 100, 200];
    const poor = [100, 200, 300, 400, 500];
    const oRich = rollOffer(rich, 10000000, COMMON, 1, false, stubRng(0.5));
    const oPoor = rollOffer(poor, 10000000, COMMON, 1, false, stubRng(0.5));
    expect(oPoor.offerFen).toBeLessThan(oRich.offerFen);
  });

  it('同 seed 同输入 → 报价一致（k 由注入随机流决定）', () => {
    const remaining = [111, 222, 333, 444, 555];
    const a = rollOffer(remaining, 1000000, COMMON, 2, false, createAlea('offer-seed'));
    const b = rollOffer(remaining, 1000000, COMMON, 2, false, createAlea('offer-seed'));
    expect(a).toEqual(b);
  });
});

describe('game-engine/offer：checkCounterLegal（3.6.5 合法性）', () => {
  const remaining = [100, 5000, 88800]; // 最低面额 100 分

  it('合法还价返回 null', () => {
    expect(checkCounterLegal(5000, remaining, 1000000)).toBeNull();
    expect(checkCounterLegal(100, remaining, 1000000)).toBeNull(); // 恰为最低面额
    expect(checkCounterLegal(1000000, remaining, 1000000)).toBeNull(); // 恰为上限
  });

  it('非整数驳回', () => {
    expect(checkCounterLegal(100.5, remaining, 1000000)).not.toBeNull();
  });

  it('低于场上最低面额驳回（含负数）', () => {
    expect(checkCounterLegal(99, remaining, 1000000)).not.toBeNull();
    expect(checkCounterLegal(0, remaining, 1000000)).not.toBeNull();
    expect(checkCounterLegal(-100, remaining, 1000000)).not.toBeNull();
  });

  it('超过档位上限驳回', () => {
    expect(checkCounterLegal(1000001, remaining, 1000000)).not.toBeNull();
  });

  it('剩余卡为空时驳回（防御分支）', () => {
    expect(checkCounterLegal(100, [], 1000000)).not.toBeNull();
  });
});

describe('game-engine/offer：evaluateCounter（3.6.5 公式钉死）', () => {
  const EV = 1000000; // 10000 元，恰整便于边界

  it('还价 ≤ 0.85EV 必接受（不抽籤）', () => {
    const at = evaluateCounter(850000, EV, COUNTER_CFG, stubRng(0.999));
    expect(at.accepted).toBe(true);
    expect(at.draw).toBeNull();
    const below = evaluateCounter(849999, EV, COUNTER_CFG, stubRng(0.999));
    expect(below.accepted).toBe(true);
  });

  it('还价 > EV 必拒（不抽籤）', () => {
    const r = evaluateCounter(1000001, EV, COUNTER_CFG, stubRng(0));
    expect(r.accepted).toBe(false);
    expect(r.probability).toBe(0);
    expect(r.draw).toBeNull();
  });

  it('EV 恰好处按 P=0.3 判定：draw < 0.3 接受，否则拒绝', () => {
    const accept = evaluateCounter(1000000, EV, COUNTER_CFG, stubRng(0.29));
    expect(accept.probability).toBeCloseTo(0.3, 10);
    expect(accept.draw).toBe(0.29);
    expect(accept.accepted).toBe(true);
    const rejectEq = evaluateCounter(1000000, EV, COUNTER_CFG, stubRng(0.3));
    expect(rejectEq.accepted).toBe(false); // 严格小于
    const rejectAbove = evaluateCounter(1000000, EV, COUNTER_CFG, stubRng(0.31));
    expect(rejectAbove.accepted).toBe(false);
  });

  it('区间中点线性插值：x=0.925EV → P=0.6', () => {
    const r = evaluateCounter(925000, EV, COUNTER_CFG, stubRng(0.599999));
    expect(r.probability).toBeCloseTo(0.6, 6);
    expect(r.accepted).toBe(true);
    const r2 = evaluateCounter(925000, EV, COUNTER_CFG, stubRng(0.6));
    expect(r2.accepted).toBe(false);
  });

  it('0.85EV 上沿极限（> 阈值 1 分）按 P≈0.9 判定', () => {
    const r = evaluateCounter(850001, EV, COUNTER_CFG, stubRng(0.899));
    expect(r.probability).toBeGreaterThan(0.89);
    expect(r.accepted).toBe(true);
    const r2 = evaluateCounter(850001, EV, COUNTER_CFG, stubRng(0.9999));
    expect(r2.accepted).toBe(false);
  });
});
