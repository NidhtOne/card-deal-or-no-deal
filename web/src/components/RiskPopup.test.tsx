// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * RiskPopup 通用受控组件单测（铁律 9；3.11 两触发点复用同一组件）：
 * 文案逐字渲染、取消按钮可传参（触发点 2 无取消）、确认/取消回调。
 */
import RiskPopup from './RiskPopup';
import { RISK_TEXT_BAILOUT, RISK_TEXT_ENTRY } from './riskPopupText';

afterEach(cleanup);

describe('RiskPopup（通用受控组件；附录 A：风险提示弹窗两处触发、可全局关闭——组件文案与回调，开关显隐见 riskPopupText.test.ts 与 LobbyPage.riskPopup.test.tsx）', () => {
  it('渲染逐字文案（触发点 1）', () => {
    const { getByRole, getByText } = render(
      <RiskPopup message={RISK_TEXT_ENTRY} onConfirm={() => undefined} cancelText="取消" />,
    );
    expect(getByRole('alertdialog')).toBeTruthy();
    // 逐字：textContent 与 3.11 原文一字不差
    expect(getByText(RISK_TEXT_ENTRY).textContent).toBe(
      '提示：本游戏仅为虚拟娱乐，对局存在亏损风险，入场资金输掉不予返还，请理性游玩',
    );
  });

  it('渲染逐字文案（触发点 2）', () => {
    const { getByText } = render(
      <RiskPopup message={RISK_TEXT_BAILOUT} onConfirm={() => undefined} />,
    );
    expect(getByText(RISK_TEXT_BAILOUT).textContent).toBe(
      '提示：您今日已经多次使用破产救助，请适当休息，注意游戏节奏',
    );
  });

  it('触发点 1：确认/取消回调触发', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { getByText } = render(
      <RiskPopup message={RISK_TEXT_ENTRY} onConfirm={onConfirm} onCancel={onCancel} cancelText="取消" />,
    );
    fireEvent.click(getByText('取消'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(getByText('确认'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('触发点 2：不传 cancelText 时仅确认按钮（信息型提醒）', () => {
    const { getByText, queryByText } = render(
      <RiskPopup message={RISK_TEXT_BAILOUT} onConfirm={() => undefined} />,
    );
    expect(queryByText('取消')).toBeNull();
    expect(getByText('确认')).toBeTruthy();
  });

  it('确认按钮文案可传参', () => {
    const { getByText } = render(
      <RiskPopup message={RISK_TEXT_ENTRY} onConfirm={() => undefined} confirmText="知道了" />,
    );
    expect(getByText('知道了')).toBeTruthy();
  });
});
