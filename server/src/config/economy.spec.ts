import { parseEconomyExt } from './economy';

/**
 * parseEconomyExt fail fast 校验（任务书 §8.5）：非法配置启动期即抛错。
 * 全部用内联样本（不依赖真实 config 文件），逐项构造非法值断言拒绝。
 */

/** 最小合法样本（数值任意合法，供各用例 mutate） */
function validSample(): Record<string, unknown> {
  return {
    initial_funds: 10000,
    signin: {
      base_reward: 100,
      multiplier_bp: [
        { day: 1, bp: 10000 },
        { day: 2, bp: 12000 },
        { day: 7, bp: 20000 },
      ],
    },
    tasks: {
      list: [
        { code: 'atm_1', name: '新手试水', tier: 1, target: 1, reward: 100 },
        { code: 'grind_3', name: '勤奋玩家', tier: null, target: 3, reward: 300 },
      ],
    },
    bailout: { threshold: 388, amount: 500, max_per_day: 3 },
    achievements: {
      list: [
        { code: 'first_match', name: '初出茅庐', reward: 150 },
        { code: 'million_dream', name: '百万梦想', reward: 800, prize_threshold: 1000000 },
        { code: 'win_streak', name: '连胜猎手', reward: 500, streak: 5 },
        { code: 'hundred_games', name: '勤劳玩家', reward: 600, games: 100 },
      ],
    },
  };
}

describe('parseEconomyExt：合法样本解析（元转分）', () => {
  it('全量解析成功且金额统一转分', () => {
    const cfg = parseEconomyExt(validSample());
    expect(cfg.signin.baseRewardFen).toBe(10000);
    expect(cfg.tasks[0].rewardFen).toBe(10000);
    expect(cfg.tasks[1].tier).toBeNull();
    expect(cfg.bailout).toEqual({ thresholdFen: 38800, amountFen: 50000, maxPerDay: 3 });
    expect(cfg.achievements[1].prizeThresholdFen).toBe(100000000);
    expect(cfg.achievements[2].streak).toBe(5);
    expect(cfg.achievements[3].games).toBe(100);
  });
});

describe('parseEconomyExt：signin 段 fail fast', () => {
  it('bp 递减 → 拒绝（连签越长奖励不得变低）', () => {
    const s = validSample();
    (s.signin as Record<string, unknown>).multiplier_bp = [
      { day: 1, bp: 12000 },
      { day: 2, bp: 10000 },
    ];
    expect(() => parseEconomyExt(s)).toThrow(/bp 必须单调不减/);
  });

  it('day 不从 1 起 → 拒绝', () => {
    const s = validSample();
    (s.signin as Record<string, unknown>).multiplier_bp = [{ day: 2, bp: 10000 }];
    expect(() => parseEconomyExt(s)).toThrow(/首档 day 必须为 1/);
  });

  it('day 非严格递增（重复 day）→ 拒绝', () => {
    const s = validSample();
    (s.signin as Record<string, unknown>).multiplier_bp = [
      { day: 1, bp: 10000 },
      { day: 1, bp: 12000 },
    ];
    expect(() => parseEconomyExt(s)).toThrow(/day 必须严格递增/);
  });

  it('base_reward 非正数 → 拒绝', () => {
    for (const bad of [0, -100, '100', null]) {
      const s = validSample();
      (s.signin as Record<string, unknown>).base_reward = bad;
      expect(() => parseEconomyExt(s)).toThrow(/base_reward/);
    }
  });

  it('multiplier_bp 空数组 → 拒绝', () => {
    const s = validSample();
    (s.signin as Record<string, unknown>).multiplier_bp = [];
    expect(() => parseEconomyExt(s)).toThrow(/multiplier_bp 必须是非空数组/);
  });
});

describe('parseEconomyExt：tasks 段 fail fast', () => {
  it('tier=6 超出五档 → 拒绝', () => {
    const s = validSample();
    (
      (s.tasks as Record<string, unknown>).list as Record<string, unknown>[]
    )[0].tier = 6;
    expect(() => parseEconomyExt(s)).toThrow(/tier 必须在 1–5/);
  });

  it('任务 code 重复 → 拒绝', () => {
    const s = validSample();
    ((s.tasks as Record<string, unknown>).list as Record<string, unknown>[])[1].code = 'atm_1';
    expect(() => parseEconomyExt(s)).toThrow(/code 重复/);
  });

  it('任务 reward 非正数 → 拒绝', () => {
    const s = validSample();
    ((s.tasks as Record<string, unknown>).list as Record<string, unknown>[])[0].reward = -1;
    expect(() => parseEconomyExt(s)).toThrow(/reward 必须为正数/);
  });

  it('target 非正整数 → 拒绝', () => {
    const s = validSample();
    ((s.tasks as Record<string, unknown>).list as Record<string, unknown>[])[0].target = 0;
    expect(() => parseEconomyExt(s)).toThrow(/target 必须是正整数/);
  });

  it('tasks.list 空数组 → 拒绝', () => {
    const s = validSample();
    (s.tasks as Record<string, unknown>).list = [];
    expect(() => parseEconomyExt(s)).toThrow(/tasks\.list 必须是非空数组/);
  });
});

describe('parseEconomyExt：bailout 段 fail fast', () => {
  it('threshold/amount 非正数或 max_per_day 非正整数 → 拒绝', () => {
    for (const patch of [
      { threshold: 0 },
      { amount: -5 },
      { max_per_day: 0 },
      { max_per_day: 1.5 },
    ]) {
      const s = validSample();
      Object.assign(s.bailout as Record<string, unknown>, patch);
      expect(() => parseEconomyExt(s)).toThrow();
    }
  });
});

describe('parseEconomyExt：achievements 段 fail fast', () => {
  it('成就 code 重复 → 拒绝', () => {
    const s = validSample();
    (
      (s.achievements as Record<string, unknown>).list as Record<string, unknown>[]
    )[1].code = 'first_match';
    expect(() => parseEconomyExt(s)).toThrow(/code 重复/);
  });

  it('成就 reward 非正数 → 拒绝', () => {
    const s = validSample();
    (
      (s.achievements as Record<string, unknown>).list as Record<string, unknown>[]
    )[0].reward = 0;
    expect(() => parseEconomyExt(s)).toThrow(/reward 必须为正数/);
  });

  it('prize_threshold 非正数 → 拒绝', () => {
    const s = validSample();
    (
      (s.achievements as Record<string, unknown>).list as Record<string, unknown>[]
    )[1].prize_threshold = -100;
    expect(() => parseEconomyExt(s)).toThrow(/prize_threshold/);
  });
});

describe('parseEconomyExt：段缺失 fail fast', () => {
  it('signin/tasks/bailout/achievements 任一缺失 → 拒绝', () => {
    for (const key of ['signin', 'tasks', 'bailout', 'achievements']) {
      const s = validSample();
      delete s[key];
      expect(() => parseEconomyExt(s)).toThrow();
    }
  });

  it('根非对象 → 拒绝', () => {
    expect(() => parseEconomyExt(null)).toThrow();
    expect(() => parseEconomyExt([1, 2])).toThrow();
  });
});
