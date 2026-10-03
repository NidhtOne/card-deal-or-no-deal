import { calcTaxFen, deriveQuickDeductions } from '../game-engine';
import type { TaxConfig } from '../game-engine';
import type { WinStreakGuardConfig } from '../config/economy';
import {
  defaultGuardUserState,
  resolveSettleWithGuard,
  type GuardUserState,
} from './win-streak-guard';

/**
 * 连胜盈利冻结机制单测（纯函数；【文档外补充：2026-10-03 人工决策落地】）。
 * 铁律 3（禁编造数值进 economy.json）：全部数值为测试内注入的 fixture，
 * 与 config/economy.json（null + enabled:false）无关。
 */

/** fixture：AGENTS.md 铁律 8 修正版阶梯税（起征点 100000 分=1000 元，五级累进） */
const TAX: TaxConfig = {
  thresholdFen: 100000,
  bracketsFen: [500000, 2000000, 10000000, 50000000],
  ratesBp: [300, 1000, 2000, 2800, 3500],
};

/** fixture：冻结参数（trigger=500 元累计、保留 50%、单局封顶 200 元、24h 重置） */
function guardFixture(enabled: boolean): WinStreakGuardConfig {
  return {
    enabled,
    triggerProfitFen: 50000,
    keepRatioBp: 5000,
    capFen: 20000,
    resetHours: 24,
  };
}

const DISABLED: WinStreakGuardConfig = {
  enabled: false,
  triggerProfitFen: null,
  keepRatioBp: null,
  capFen: null,
  resetHours: null,
};

const NOW = 1_700_000_000_000;

function frozenState(over: Partial<GuardUserState> = {}): GuardUserState {
  return {
    ...defaultGuardUserState(),
    guardFrozen: 1,
    guardTriggeredAt: NOW - 1000,
    ...over,
  };
}

/** 引擎同口径税额（P 的既有税，用于断言「税按截断后」差异） */
function engineTax(p: number): number {
  return calcTaxFen(p, TAX).taxFen;
}

describe('resolveSettleWithGuard：enabled=false（功能关闭=现有行为完全不变）', () => {
  it('冻结标志遗留也不截断：kept=P、税/流水/净盈亏全按既有口径，计数器照常累计', () => {
    // 遗留 guard_frozen=1 的行（如先 enabled 后关闭），关闭态必须零改动
    const r = resolveSettleWithGuard({
      now: NOW,
      profitFen: 300000,
      engineTaxFen: engineTax(300000),
      entryFeeFen: 38800,
      state: frozenState({ winStreak: 2, streakProfitFen: 100000 }),
      guard: DISABLED,
      tax: TAX,
    });
    expect(r.truncated).toBe(false);
    expect(r.keptProfitFen).toBe(300000);
    expect(r.taxFen).toBe(engineTax(300000));
    expect(r.bonusDeltaFen).toBe(338800);
    expect(r.forfeitedFen).toBe(0);
    expect(r.netProfitFen).toBe(300000 - engineTax(300000));
    expect(r.nextState).toEqual({
      winStreak: 3,
      streakProfitFen: 100000 + r.netProfitFen,
      guardFrozen: 1, // 关闭态不触碰冻结列
      guardTriggeredAt: NOW - 1000,
      totalSettledGames: 1,
    });
  });
});

describe('resolveSettleWithGuard：冻结中盈利局截断（决策原文行为 C）', () => {
  it('kept = min(floor(P×50%), cap)，作废=P−kept，税按 kept，net=kept−tax', () => {
    const P = 300000; // 税前盈利 3000 元
    const r = resolveSettleWithGuard({
      now: NOW,
      profitFen: P,
      engineTaxFen: engineTax(P),
      entryFeeFen: 38800,
      state: frozenState(),
      guard: guardFixture(true),
      tax: TAX,
    });
    const kept = Math.min(Math.floor((P * 5000) / 10000), 20000); // cap 生效 → 20000
    expect(kept).toBe(20000);
    expect(r.truncated).toBe(true);
    expect(r.keptProfitFen).toBe(kept);
    expect(r.forfeitedFen).toBe(P - kept);
    expect(r.taxFen).toBe(calcTaxFen(kept, TAX).taxFen); // 200 元 ≤ 起征点 → 税 0
    expect(r.netProfitFen).toBe(kept);
    // 奖金流水 = 入场回收 + kept（作废部分不发放、不写流水）
    expect(r.bonusDeltaFen).toBe(38800 + kept);
    expect(r.nextState.winStreak).toBe(1);
    expect(r.nextState.streakProfitFen).toBe(kept);
    expect(r.nextState.totalSettledGames).toBe(1);
  });

  it('税基=截断后金额：大 cap fixture 下 kept=floor(P×50%)，税 ≠ 引擎原税', () => {
    const P = 3000000; // 30000 元
    const r = resolveSettleWithGuard({
      now: NOW,
      profitFen: P,
      engineTaxFen: engineTax(P),
      entryFeeFen: 2000000,
      state: frozenState(),
      guard: { ...guardFixture(true), capFen: 5000000 }, // cap 不截断，比例生效
      tax: TAX,
    });
    const kept = Math.floor((P * 5000) / 10000); // 1500000 分 = 15000 元
    expect(r.keptProfitFen).toBe(kept);
    expect(r.taxFen).toBe(calcTaxFen(kept, TAX).taxFen);
    expect(r.taxFen).not.toBe(engineTax(P)); // 税基=截断后，而非 P
    expect(r.netProfitFen).toBe(kept - r.taxFen);
  });

  it('截断后 kept 超起征点时税 > 0（税基=kept）', () => {
    const P = 1_000_000; // 1 万元
    const r = resolveSettleWithGuard({
      now: NOW,
      profitFen: P,
      engineTaxFen: engineTax(P),
      entryFeeFen: 38800,
      state: frozenState(),
      guard: { ...guardFixture(true), capFen: 5000000 }, // cap 不生效
      tax: TAX,
    });
    const kept = Math.floor(P / 2); // 500000 分 = 5000 元
    const tax = calcTaxFen(kept, TAX).taxFen; // 应税 400000 → 400000×3% = 12000
    expect(tax).toBe(12000);
    expect(r.taxFen).toBe(tax);
    expect(r.netProfitFen).toBe(kept - tax);
    expect(r.nextState.streakProfitFen).toBe(kept - tax);
  });
});

describe('resolveSettleWithGuard：亏损/保本不截断（决策原文）', () => {
  it('P ≤ 0 不截断：亏损局全额入账，赢输判定只看净盈亏', () => {
    const r = resolveSettleWithGuard({
      now: NOW,
      profitFen: -30000,
      engineTaxFen: 0,
      entryFeeFen: 38800,
      state: frozenState({ winStreak: 3, streakProfitFen: 90000 }),
      guard: guardFixture(true),
      tax: TAX,
    });
    expect(r.truncated).toBe(false);
    expect(r.keptProfitFen).toBe(-30000);
    expect(r.bonusDeltaFen).toBe(38800 - 30000);
    expect(r.forfeitedFen).toBe(0);
    expect(r.nextState.winStreak).toBe(0);
    expect(r.nextState.streakProfitFen).toBe(0);
    expect(r.nextState.guardFrozen).toBe(0); // 输一局解除（决策原文）
    expect(r.nextState.guardTriggeredAt).toBeNull();
  });

  it('保本局（net=0）：全部计数器不变（沿用 M4 口径 d「保本不中断不计入」）', () => {
    const r = resolveSettleWithGuard({
      now: NOW,
      profitFen: 0,
      engineTaxFen: 0,
      entryFeeFen: 38800,
      state: frozenState({ winStreak: 3, streakProfitFen: 90000 }),
      guard: guardFixture(true),
      tax: TAX,
    });
    expect(r.truncated).toBe(false);
    expect(r.netProfitFen).toBe(0);
    expect(r.nextState).toEqual({
      winStreak: 3,
      streakProfitFen: 90000,
      guardFrozen: 1,
      guardTriggeredAt: NOW - 1000,
      totalSettledGames: 1,
    });
  });
});

describe('resolveSettleWithGuard：触发判定（对下一局生效）', () => {
  it('累计税后净利达到 trigger → 冻结，triggered_at=now，本局未截断', () => {
    const r = resolveSettleWithGuard({
      now: NOW,
      profitFen: 60000,
      engineTaxFen: 0, // 600 元 ≤ 起征点无税
      entryFeeFen: 38800,
      state: { ...defaultGuardUserState(), winStreak: 1, streakProfitFen: 10000 },
      guard: guardFixture(true),
      tax: TAX,
    });
    expect(r.truncated).toBe(false); // 触发对下一局生效，本局不截断
    expect(r.nextState.streakProfitFen).toBe(70000);
    expect(r.nextState.guardFrozen).toBe(1);
    expect(r.nextState.guardTriggeredAt).toBe(NOW);
  });

  it('累计未达 trigger → 不冻结；亏损清零后重新累计', () => {
    const r = resolveSettleWithGuard({
      now: NOW,
      profitFen: 30000,
      engineTaxFen: 0,
      entryFeeFen: 38800,
      state: defaultGuardUserState(),
      guard: guardFixture(true),
      tax: TAX,
    });
    expect(r.nextState.streakProfitFen).toBe(30000);
    expect(r.nextState.guardFrozen).toBe(0);
  });

  it('连续盈利局逐局累计直至触发（含税后净利，而非税前利润）', () => {
    // 6000 元盈利：税 = (600000−100000)×3% = 15000 分 → 净 585000 < 50000？否 585000 > 50000 直接触发
    const r = resolveSettleWithGuard({
      now: NOW,
      profitFen: 600000,
      engineTaxFen: engineTax(600000),
      entryFeeFen: 38800,
      state: defaultGuardUserState(),
      guard: guardFixture(true),
      tax: TAX,
    });
    expect(r.nextState.streakProfitFen).toBe(600000 - 15000);
    expect(r.nextState.guardFrozen).toBe(1);
  });
});

describe('resolveSettleWithGuard：定时重置（reset_hours 自触发时刻起算）', () => {
  it('到期先解冻：到期后的第一局盈利不截断，随后按落账累计可立即再冻结', () => {
    const r = resolveSettleWithGuard({
      now: NOW + 25 * 3600 * 1000, // 触发后 25h > 24h
      profitFen: 60000,
      engineTaxFen: 0,
      entryFeeFen: 38800,
      state: frozenState({ winStreak: 1, streakProfitFen: 45000, guardTriggeredAt: NOW }),
      guard: guardFixture(true),
      tax: TAX,
    });
    expect(r.truncated).toBe(false); // 到期首局不截断
    expect(r.nextState.guardFrozen).toBe(1); // 45000+60000 ≥ 50000 → 落账后再冻结
    expect(r.nextState.guardTriggeredAt).toBe(NOW + 25 * 3600 * 1000);
  });

  it('未到期不解冻：冻结中继续截断', () => {
    const r = resolveSettleWithGuard({
      now: NOW + 23 * 3600 * 1000,
      profitFen: 60000,
      engineTaxFen: 0,
      entryFeeFen: 38800,
      state: frozenState({ guardTriggeredAt: NOW }),
      guard: guardFixture(true),
      tax: TAX,
    });
    expect(r.truncated).toBe(true);
    expect(r.nextState.guardFrozen).toBe(1);
  });

  it('恰好到期（=reset_hours）也算到期（≥ 判定）', () => {
    const r = resolveSettleWithGuard({
      now: NOW + 24 * 3600 * 1000,
      profitFen: 60000,
      engineTaxFen: 0,
      entryFeeFen: 38800,
      state: frozenState({ guardTriggeredAt: NOW }),
      guard: guardFixture(true),
      tax: TAX,
    });
    expect(r.truncated).toBe(false);
  });
});

describe('deriveQuickDeductions：fixture 税配置与铁律 8 验收例一致', () => {
  it('盈利 20000 元 → 税 1550 元；亏损局税 0', () => {
    // 2000000 分盈利：应税 1900000 分 → 1900000×10% − 35000/10000... 直接用引擎口径断言
    expect(engineTax(2000000)).toBe(155000); // 1550 元
    expect(calcTaxFen(-500, TAX).taxFen).toBe(0);
    // 速算扣除数自动推导（不硬编码）：0/350/2350/10350/45350 元 → 分
    expect(deriveQuickDeductions(TAX).map((d) => d / 10000)).toEqual([
      0, 35000, 235000, 1035000, 4535000,
    ]);
  });
});
