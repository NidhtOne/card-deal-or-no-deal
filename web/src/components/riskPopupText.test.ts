import { describe, expect, it } from 'vitest';

/**
 * 风险提示弹窗纯逻辑单测（铁律 9；docs/开发文档.md 3.11）：
 * - 两处触发点文案逐字相等（expect(text).toBe(逐字串)，一字不差）；
 * - 开关显隐：risk_popup_enabled=false 时两触发点均不弹；
 * - 触发点 1 排除取款机档（tier===1）；触发点 2 依据 needsReminder（第 2/3 次救助）。
 */
import {
  RISK_TEXT_BAILOUT,
  RISK_TEXT_ENTRY,
  shouldShowBailoutReminder,
  shouldShowEntryRisk,
} from './riskPopupText';

describe('文案逐字相等（3.11，一字不差）', () => {
  it('触发点 1（进入非取款机档位）', () => {
    expect(RISK_TEXT_ENTRY).toBe(
      '提示：本游戏仅为虚拟娱乐，对局存在亏损风险，入场资金输掉不予返还，请理性游玩',
    );
  });

  it('触发点 2（当日第 2、3 次破产救助）', () => {
    expect(RISK_TEXT_BAILOUT).toBe(
      '提示：您今日已经多次使用破产救助，请适当休息，注意游戏节奏',
    );
  });
});

describe('触发点 1 开关显隐（进入档位）', () => {
  it.each([
    [1, true, false], // 取款机档不提示
    [1, false, false],
    [2, true, true],
    [5, true, true],
    [2, false, false], // 总开关 off → 不弹（直接开局）
    [5, false, false],
  ])('tier=%s, risk_popup_enabled=%s → %s', (tier, enabled, expected) => {
    expect(shouldShowEntryRisk(tier, enabled)).toBe(expected);
  });
});

describe('触发点 2 开关显隐（依据 needsReminder）', () => {
  it.each([
    [true, true, true], // 第 2/3 次申请 + 开关开 → 弹
    [true, false, false], // 开关 off → 不弹
    [false, true, false], // 第 1 次申请（needsReminder=false）→ 不弹
    [false, false, false],
  ])('needsReminder=%s, risk_popup_enabled=%s → %s', (needsReminder, enabled, expected) => {
    expect(shouldShowBailoutReminder(needsReminder, enabled)).toBe(expected);
  });
});
