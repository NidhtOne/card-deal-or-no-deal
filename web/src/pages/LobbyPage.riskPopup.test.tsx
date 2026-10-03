// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LobbyPage 风险提示弹窗两触发点集成测试（铁律 9；docs/开发文档.md 3.11 / 3.8.4）：
 * - 触发点 1：点击非取款机档位 → 弹逐字文案；确认 → 才调 /api/match/start；取消 → 不调留原页；
 *   取款机档（tier=1）与 risk_popup_enabled=off 直接开局不弹；
 * - 触发点 2：POST /api/bailout 返回 needsReminder=true → 弹逐字文案；off 时不弹。
 * 全部 API 模块 mock；弹窗文案断言逐字相等。
 */
vi.mock('../api/match', () => ({
  matchApi: {
    getTiers: vi.fn(),
    start: vi.fn(),
  },
  getStartConflictSessionId: () => null,
  isHttpStatus: () => false,
}));
vi.mock('../api/wallet', () => ({ walletApi: { getWallet: vi.fn() } }));
vi.mock('../api/user', () => ({
  userApi: { getSettings: vi.fn(), getOverview: vi.fn() },
}));
vi.mock('../api/economy', () => ({
  economyApi: {
    signin: vi.fn(),
    getTasks: vi.fn(),
    claimTask: vi.fn(),
    applyBailout: vi.fn(),
    getAchievements: vi.fn(),
    claimAchievement: vi.fn(),
  },
}));

import { economyApi } from '../api/economy';
import { matchApi } from '../api/match';
import { userApi } from '../api/user';
import { walletApi } from '../api/wallet';
import LobbyPage from './LobbyPage';
import { useAuthStore } from '../store/auth';

const TIERS = [
  { tier: 1, name: '取款机', entryFeeFen: 38800, maxPrizeFen: 388800 },
  { tier: 2, name: '入门档', entryFeeFen: 100000, maxPrizeFen: 1000000 },
];

function mockAll(over: { riskPopupEnabled?: boolean; needsReminder?: boolean } = {}) {
  const riskPopupEnabled = over.riskPopupEnabled ?? true;
  (matchApi.getTiers as ReturnType<typeof vi.fn>).mockResolvedValue(TIERS);
  (matchApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
    sessionId: 7,
    state: {},
  });
  (walletApi.getWallet as ReturnType<typeof vi.fn>).mockResolvedValue({ balanceFen: 1000000 });
  (userApi.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
    bgmEnabled: true,
    bgmTrack: 'lobby.wav',
    volume: 60,
    sfxEnabled: true,
    sfxVolume: 80,
    amountListEnabled: true,
    riskPopupEnabled,
    achievementEnabled: true,
    availableTracks: ['lobby.wav'],
  });
  (userApi.getOverview as ReturnType<typeof vi.fn>).mockResolvedValue({
    balance: 10000,
    todaySignedIn: true,
    signinStreakDays: 1,
    todayBailoutUsed: 1,
    bailoutEligible: true,
    bailoutMaxPerDay: 3,
    totalMatches: 0,
    totalProfit: 0,
    winRate: 0,
  });
  (economyApi.getAchievements as ReturnType<typeof vi.fn>).mockResolvedValue({
    enabled: true,
    list: [],
  });
  (economyApi.applyBailout as ReturnType<typeof vi.fn>).mockResolvedValue({
    amountFen: 50000,
    timesUsed: 2,
    remaining: 1,
    needsReminder: over.needsReminder ?? true,
    balanceFen: 538800,
    refId: 9,
  });
}

async function renderLobby() {
  const { container } = render(
    <MemoryRouter initialEntries={['/lobby']}>
      <LobbyPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('入门档')).toBeTruthy());
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    accessToken: 't',
    refreshToken: 'r',
    user: { id: 1, username: 'tester' },
  });
});

afterEach(cleanup);

describe('触发点 1：进入非取款机档位（3.11 第 1 条；附录 A：风险提示弹窗两处触发、可全局关闭）', () => {
  it('弹出逐字文案；取消 → 不调 start 留在原页；确认 → 才调 start', async () => {
    mockAll();
    await renderLobby();

    fireEvent.click(screen.getByText('入门档'));
    // 文案逐字相等（一字不差）
    expect(
      screen.getByText(
        '提示：本游戏仅为虚拟娱乐，对局存在亏损风险，入场资金输掉不予返还，请理性游玩',
      ).textContent,
    ).toBe('提示：本游戏仅为虚拟娱乐，对局存在亏损风险，入场资金输掉不予返还，请理性游玩');

    // 取消：不调 start，弹窗关闭
    fireEvent.click(screen.getByText('取消'));
    expect(matchApi.start).not.toHaveBeenCalled();

    // 再次点击并确认：此时才调 start
    fireEvent.click(screen.getByText('入门档'));
    fireEvent.click(screen.getByText('确认'));
    await waitFor(() => expect(matchApi.start).toHaveBeenCalledTimes(1));
    expect(matchApi.start).toHaveBeenCalledWith(2, expect.any(String));
  });

  it('取款机档（tier=1）不弹直接开局', async () => {
    mockAll();
    await renderLobby();

    fireEvent.click(screen.getByText('取款机'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(matchApi.start).toHaveBeenCalledWith(1, expect.any(String)));
  });

  it('risk_popup_enabled=off 跳过弹窗直接开局（现状逻辑等价物）', async () => {
    mockAll({ riskPopupEnabled: false });
    await renderLobby();

    fireEvent.click(screen.getByText('入门档'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(matchApi.start).toHaveBeenCalledTimes(1));
  });
});

describe('触发点 2：多次破产救助提醒（3.11 第 2 条，依据 needsReminder；附录 A：风险提示弹窗两处触发、可全局关闭）', () => {
  it('needsReminder=true 弹逐字文案（仅确认按钮）', async () => {
    mockAll({ needsReminder: true });
    await renderLobby();

    fireEvent.click(screen.getByText('破产救助', { exact: false }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    const text = screen.getByText(
      '提示：您今日已经多次使用破产救助，请适当休息，注意游戏节奏',
    );
    expect(text.textContent).toBe('提示：您今日已经多次使用破产救助，请适当休息，注意游戏节奏');
    // 触发点 2 为信息型：无取消按钮
    expect(screen.queryByText('取消')).toBeNull();
    fireEvent.click(screen.getByText('确认'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('needsReminder=false（第 1 次救助）不弹', async () => {
    mockAll({ needsReminder: false });
    await renderLobby();

    fireEvent.click(screen.getByText('破产救助', { exact: false }));
    await waitFor(() =>
      expect(economyApi.applyBailout as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('risk_popup_enabled=off 不弹（救助照常到账）', async () => {
    mockAll({ riskPopupEnabled: false, needsReminder: true });
    await renderLobby();

    fireEvent.click(screen.getByText('破产救助', { exact: false }));
    await waitFor(() =>
      expect(economyApi.applyBailout as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
