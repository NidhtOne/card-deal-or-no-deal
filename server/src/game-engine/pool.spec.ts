import { generatePoolFen } from './pool';
import { parseTiersConfig, POOL_SIZE } from './config';
import { createAlea } from './rng';
import type { CommonConfig, TierConfig } from './types';

/** 受控 fixture：与 config.spec 同形，jitter 可调 */
function makeTierAndCommon(jitter: number): { tier: TierConfig; common: CommonConfig } {
  const raw = {
    common: {
      flip_sequence: [6, 5, 4, 3, 2],
      anchor_amounts: [0.01, 0.1, 1, 10, 50],
      pool_jitter: jitter,
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
        weights: [
          0.5, 0.5, 0.5, 0.5, 0.5, 0.6, 0.6, 0.6, 0.6, 0.7, 0.7, 0.7, 0.8, 0.8, 0.8, 0.9, 0.9, 0.9,
          1, 1, 1.1, 1.1, 1.2, 1.2, 1.3, 1.5,
        ],
      },
    },
  };
  const cfg = parseTiersConfig(raw);
  return { tier: cfg.tiers.test, common: cfg.common };
}

const ANCHORS_FEN = [1, 10, 100, 1000, 5000];

describe('game-engine/pool：卡池生成（3.6.2、七章.1；附录 A：26 张卡/局、金额唯一、无固定总额）', () => {
  it('26 张互不重复、全部落在 [1, 档位上限]（附录 A：26 张卡/局、金额唯一）', () => {
    const { tier, common } = makeTierAndCommon(0.25);
    for (const seed of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      const pool = generatePoolFen(tier, common, createAlea(seed));
      expect(pool).toHaveLength(POOL_SIZE);
      expect(new Set(pool).size).toBe(POOL_SIZE);
      for (const v of pool) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(tier.maxPrizeFen);
      }
    }
  });

  it('无固定总额：多 seed 卡池总和各不相同（附录 A：26 张卡/局、金额唯一、无固定总额）', () => {
    const { tier, common } = makeTierAndCommon(0.25);
    const sums = new Set<number>();
    for (let i = 0; i < 12; i++) {
      const pool = generatePoolFen(tier, common, createAlea(`sum-${i}`));
      expect(pool).toHaveLength(POOL_SIZE);
      sums.add(pool.reduce((acc, v) => acc + v, 0));
    }
    // 逐张扰动使总和随 seed 波动；12 个 seed 至少出现 2 种不同总额（非固定总额）
    expect(sums.size).toBeGreaterThanOrEqual(2);
  });

  it('必含小额锚点（0.01/0.1/1/10/50 元，固定不扰动）', () => {
    const { tier, common } = makeTierAndCommon(0.9); // 大扰动下锚点也不动
    for (const seed of ['a1', 'a2', 'a3']) {
      const pool = generatePoolFen(tier, common, createAlea(seed));
      for (const anchor of ANCHORS_FEN) {
        expect(pool).toContain(anchor);
      }
    }
  });

  it('同 seed 复现、异 seed 不同', () => {
    const { tier, common } = makeTierAndCommon(0.25);
    const a1 = generatePoolFen(tier, common, createAlea('same-seed'));
    const a2 = generatePoolFen(tier, common, createAlea('same-seed'));
    const b = generatePoolFen(tier, common, createAlea('other-seed'));
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  it('jitter=0 时非锚点金额等于模板原值（排序后与模板一致）', () => {
    const { tier, common } = makeTierAndCommon(0);
    const pool = generatePoolFen(tier, common, createAlea('zero-jitter'));
    expect(pool.slice().sort((a, b) => a - b)).toEqual(tier.amountsFen);
  });

  it('扰动只在小范围内波动（jitter=0.25 时非锚点 ±25% 内）', () => {
    const { tier, common } = makeTierAndCommon(0.25);
    // 去掉锚点后与模板非锚点一一对应比较（两者都升序）
    const pool = generatePoolFen(tier, common, createAlea('spread-check'));
    const poolNonAnchor = pool.filter((v) => !ANCHORS_FEN.includes(v)).sort((a, b) => a - b);
    const tplNonAnchor = tier.amountsFen.filter((v) => !ANCHORS_FEN.includes(v));
    expect(poolNonAnchor).toHaveLength(tplNonAnchor.length);
    for (let i = 0; i < tplNonAnchor.length; i++) {
      // 唯一性修复可能产生 ±少量位移，容差取模板的 ±30%（略宽于 25% 以容纳修复步进）
      expect(poolNonAnchor[i]).toBeGreaterThanOrEqual(Math.floor(tplNonAnchor[i] * 0.7));
      expect(poolNonAnchor[i]).toBeLessThanOrEqual(
        Math.ceil(tplNonAnchor[i] * 1.3) + tplNonAnchor.length,
      );
    }
  });

  it('唯一性修复确定性：相邻模板值撞车时仍产出 26 个唯一值', () => {
    // 构造极易撞车的模板：大额密集 + 大扰动
    const raw = {
      common: {
        flip_sequence: [6, 5, 4, 3, 2],
        anchor_amounts: [0.01, 0.1, 1, 10, 50],
        pool_jitter: 0.9,
        k_ranges: {
          early: { min: 0.55, max: 0.75 },
          mid: { min: 0.65, max: 0.85 },
          final: { min: 0.8, max: 0.95 },
        },
        k_phase_rounds: { early_max_round: 2, mid_max_round: 4 },
        counter: { accept_ratio: 0.85, prob_hi: 0.9, prob_lo: 0.3 },
      },
      tiers: {
        dense: {
          name: '密集档',
          entry_fee: 388,
          max_prize: 100,
          amounts: [
            0.01, 0.1, 1, 10, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66,
            67, 68, 69, 70, 100,
          ],
          weights: Array(POOL_SIZE).fill(1),
        },
      },
    };
    const cfg = parseTiersConfig(raw);
    for (const seed of ['d1', 'd2', 'd3', 'd4']) {
      const pool = generatePoolFen(cfg.tiers.dense, cfg.common, createAlea(seed));
      expect(pool).toHaveLength(POOL_SIZE);
      expect(new Set(pool).size).toBe(POOL_SIZE);
      for (const v of pool) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(10000); // 100 元
      }
      // 同 seed 复现
      expect(generatePoolFen(cfg.tiers.dense, cfg.common, createAlea(seed))).toEqual(pool);
    }
  });

  it('洗牌消费随机流：同 seed 下扰动相同则洗牌结果也相同，且位置确实被打乱（长期看）', () => {
    const { tier, common } = makeTierAndCommon(0);
    // jitter=0 时不同 seed 仅洗牌不同；统计若干 seed 下首位不同的比例，确认洗牌生效
    const tpl = tier.amountsFen;
    let shuffledCount = 0;
    const seeds = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    for (const seed of seeds) {
      const pool = generatePoolFen(tier, common, createAlea(seed));
      if (pool.some((v, i) => v !== tpl[i])) shuffledCount++;
    }
    expect(shuffledCount).toBeGreaterThan(0);
  });
});
