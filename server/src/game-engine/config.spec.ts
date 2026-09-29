import { parseEconomyConfig, parseTiersConfig, yuanToFen, ConfigError } from './config';

/** 合法 tiers.json 原始形状（元），供各用例深拷贝后破坏 */
interface TestTiersRaw {
  common: {
    flip_sequence: number[];
    anchor_amounts: number[];
    pool_jitter: number;
    k_ranges: {
      early: { min: number; max: number };
      mid: { min: number; max: number };
      final: { min: number; max: number };
    };
    k_phase_rounds: { early_max_round: number; mid_max_round: number };
    counter: { accept_ratio: number; prob_hi: number; prob_lo: number };
  };
  tiers: {
    test: {
      name: string;
      entry_fee: number;
      max_prize: number;
      amounts: number[];
      weights: number[];
    };
  };
}

interface TestEconomyRaw {
  initial_funds: number;
  tax: { threshold: number; brackets: number[]; rates: number[] };
  signin: Record<string, never>;
  tasks: Record<string, never>;
  bailout: Record<string, never>;
  achievements: Record<string, never>;
}

function makeValidTiersRaw(): TestTiersRaw {
  return {
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
        weights: [
          0.5, 0.5, 0.5, 0.5, 0.5, 0.6, 0.6, 0.6, 0.6, 0.7, 0.7, 0.7, 0.8, 0.8, 0.8, 0.9, 0.9, 0.9,
          1, 1, 1.1, 1.1, 1.2, 1.2, 1.3, 1.5,
        ],
      },
    },
  };
}

function makeValidEconomyRaw(): TestEconomyRaw {
  return {
    initial_funds: 10000,
    tax: {
      threshold: 1000,
      brackets: [5000, 20000, 100000, 500000],
      rates: [0.03, 0.1, 0.2, 0.28, 0.35],
    },
    signin: {},
    tasks: {},
    bailout: {},
    achievements: {},
  };
}

describe('game-engine/config：yuanToFen（铁律 4）', () => {
  it('Math.round 转换防浮点尾差', () => {
    expect(yuanToFen(0.01)).toBe(1);
    expect(yuanToFen(0.1)).toBe(10);
    expect(yuanToFen(388)).toBe(38800);
    expect(yuanToFen(19.99)).toBe(1999);
  });
});

describe('game-engine/config：parseTiersConfig 合法配置', () => {
  it('解析成功并统一转分', () => {
    const cfg = parseTiersConfig(makeValidTiersRaw());
    const tier = cfg.tiers.test;
    expect(tier.entryFeeFen).toBe(38800);
    expect(tier.maxPrizeFen).toBe(1000000);
    expect(tier.amountsFen).toHaveLength(26);
    expect(tier.amountsFen[0]).toBe(1); // 0.01 元
    expect(tier.amountsFen[25]).toBe(1000000);
    expect(cfg.common.flipSequence).toEqual([6, 5, 4, 3, 2]);
    expect(cfg.common.anchorAmountsFen).toEqual([1, 10, 100, 1000, 5000]);
    expect(cfg.common.kRanges.early).toEqual({ min: 0.55, max: 0.75 });
    expect(cfg.common.counter).toEqual({ acceptRatio: 0.85, probHi: 0.9, probLo: 0.3 });
    expect(cfg.tierOrder).toEqual(['test']);
  });

  it('模板乱序输入会被升序排序且权重同步对齐', () => {
    const raw = makeValidTiersRaw();
    // 交换模板前两位（0.01 ↔ 0.1）及其权重
    raw.tiers.test.amounts = [0.1, 0.01, ...raw.tiers.test.amounts.slice(2)];
    raw.tiers.test.weights = [0.7, 0.9, ...raw.tiers.test.weights.slice(2)];
    const cfg = parseTiersConfig(raw);
    expect(cfg.tiers.test.amountsFen[0]).toBe(1); // 0.01 回到首位
    expect(cfg.tiers.test.amountsFen[1]).toBe(10);
    expect(cfg.tiers.test.weights[0]).toBe(0.9); // 权重跟随金额
    expect(cfg.tiers.test.weights[1]).toBe(0.7);
  });
});

describe('game-engine/config：parseTiersConfig 非法配置抛 ConfigError', () => {
  const expectBad = (mutate: (raw: TestTiersRaw) => void) => {
    const raw = makeValidTiersRaw();
    mutate(raw);
    expect(() => parseTiersConfig(raw)).toThrow(ConfigError);
  };

  it('根不是对象', () => {
    expect(() => parseTiersConfig(null)).toThrow(ConfigError);
    expect(() => parseTiersConfig([])).toThrow(ConfigError);
    expect(() => parseTiersConfig('x')).toThrow(ConfigError);
  });

  it('模板必须 26 张', () => {
    expectBad((raw) => {
      raw.tiers.test.amounts.pop();
    });
  });

  it('模板金额必须唯一（转分后碰撞也算）', () => {
    expectBad((raw) => {
      raw.tiers.test.amounts[25] = raw.tiers.test.amounts[24]; // 直接重复
    });
    expectBad((raw) => {
      raw.tiers.test.amounts[25] = 5000.001; // 与 5000 转分后同为 500000 分
    });
  });

  it('模板金额必须 > 0', () => {
    expectBad((raw) => {
      raw.tiers.test.amounts[25] = 0;
    });
  });

  it('模板金额不得超过档位上限', () => {
    expectBad((raw) => {
      raw.tiers.test.amounts[25] = 10001;
    });
  });

  it('模板必须包含小额锚点（3.6.2）', () => {
    expectBad((raw) => {
      raw.tiers.test.amounts[0] = 0.02; // 移除 0.01
    });
  });

  it('权重必须 26 个且全部 > 0', () => {
    expectBad((raw) => {
      raw.tiers.test.weights.pop();
    });
    expectBad((raw) => {
      raw.tiers.test.weights[10] = 0;
    });
    expectBad((raw) => {
      raw.tiers.test.weights[10] = -1;
    });
  });

  it('入场费/上限必须为正数', () => {
    expectBad((raw) => {
      raw.tiers.test.entry_fee = 0;
    });
    expectBad((raw) => {
      raw.tiers.test.max_prize = -5;
    });
  });

  it('k 区间必须满足 0 ≤ min ≤ max ≤ 1', () => {
    expectBad((raw) => {
      raw.common.k_ranges.early = { min: -0.1, max: 0.7 };
    });
    expectBad((raw) => {
      raw.common.k_ranges.mid = { min: 0.9, max: 0.8 };
    });
    expectBad((raw) => {
      raw.common.k_ranges.final = { min: 0.8, max: 1.1 };
    });
  });

  it('轮次映射必须是正整数且 early ≤ mid', () => {
    expectBad((raw) => {
      raw.common.k_phase_rounds = { early_max_round: 0, mid_max_round: 4 };
    });
    expectBad((raw) => {
      raw.common.k_phase_rounds = { early_max_round: 4, mid_max_round: 2 };
    });
  });

  it('还价参数必须落在合法区间', () => {
    expectBad((raw) => {
      raw.common.counter.accept_ratio = 1.2;
    });
    expectBad((raw) => {
      raw.common.counter.accept_ratio = 0;
    });
    expectBad((raw) => {
      raw.common.counter.prob_hi = 0.2;
      raw.common.counter.prob_lo = 0.3;
    });
    expectBad((raw) => {
      raw.common.counter.prob_hi = 1.1; // 超出 [0,1]
    });
  });

  it('翻牌序列必须为非空正整数数组且和 ≤ 24', () => {
    expectBad((raw) => {
      raw.common.flip_sequence = [];
    });
    expectBad((raw) => {
      raw.common.flip_sequence = [6, 0, 4];
    });
    expectBad((raw) => {
      raw.common.flip_sequence = [10, 10, 10]; // 和 30 > 24
    });
  });

  it('pool_jitter 必须落在 [0, 1)', () => {
    expectBad((raw) => {
      raw.common.pool_jitter = 1;
    });
    expectBad((raw) => {
      raw.common.pool_jitter = -0.1;
    });
  });

  it('锚点清单必须非空、为正、转分后唯一', () => {
    expectBad((raw) => {
      raw.common.anchor_amounts = [];
    });
    expectBad((raw) => {
      raw.common.anchor_amounts = [0.01, 0.010001];
    });
  });
});

describe('game-engine/config：parseEconomyConfig', () => {
  it('合法配置解析成功并转分/转基点', () => {
    const cfg = parseEconomyConfig(makeValidEconomyRaw());
    expect(cfg.tax.thresholdFen).toBe(100000);
    expect(cfg.tax.bracketsFen).toEqual([500000, 2000000, 10000000, 50000000]);
    expect(cfg.tax.ratesBp).toEqual([300, 1000, 2000, 2800, 3500]);
  });

  const expectBadTax = (mutate: (tax: TestEconomyRaw['tax']) => void) => {
    const raw = makeValidEconomyRaw();
    mutate(raw.tax);
    expect(() => parseEconomyConfig(raw)).toThrow(ConfigError);
  };

  it('缺 tax 节抛错', () => {
    const raw = makeValidEconomyRaw();
    const broken: Record<string, unknown> = { ...raw };
    delete broken.tax;
    expect(() => parseEconomyConfig(broken)).toThrow(ConfigError);
  });

  it('起征点不得为负', () => {
    expectBadTax((tax) => {
      tax.threshold = -1;
    });
  });

  it('级距必须严格递增且非空（转分后并列也算非法）', () => {
    expectBadTax((tax) => {
      tax.brackets = [5000, 5000, 100000, 500000];
    });
    expectBadTax((tax) => {
      tax.brackets = [20000, 5000, 100000, 500000];
    });
    expectBadTax((tax) => {
      tax.brackets = [];
    });
  });

  it('税率条数 = 级距数 + 1', () => {
    expectBadTax((tax) => {
      tax.rates = [0.03, 0.1, 0.2, 0.28];
    });
    expectBadTax((tax) => {
      tax.rates = [0.03, 0.1, 0.2, 0.28, 0.35, 0.4];
    });
  });

  it('税率必须在 (0,1] 且严格递增、可表示为基点整数', () => {
    expectBadTax((tax) => {
      tax.rates = [0.03, 0.1, 0.2, 0.28, 1.2];
    });
    expectBadTax((tax) => {
      tax.rates = [0.1, 0.03, 0.2, 0.28, 0.35];
    });
    expectBadTax((tax) => {
      tax.rates = [0.03, 0.1, 0.2, 0.28, 0.35555]; // 非基点整数
    });
  });
});
