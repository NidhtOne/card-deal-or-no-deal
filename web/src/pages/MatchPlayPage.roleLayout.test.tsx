// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 对局页左右布局测试 —— 附录 A 条目原文：
 * 「加载页展示银行家与用户双方角色；对局页银行家居左、用户居右」
 * （本文件覆盖后半句「对局页银行家居左、用户居右」；加载页双方角色见
 *  MatchLoadPage.roleLayout.test.tsx；真实浏览器全流程另见 Playwright test:e2e）。
 * 断言：中部三区（3.5：左银行家 / 中央卡牌区 / 右玩家）DOM 顺序 = 银行家 → 卡牌 → 用户
 * （grid-cols-[auto_1fr_auto] LTR 布局，DOM 序 = 视觉序），双方角色图同渲染。
 */
vi.mock('../api/match', () => ({
  matchApi: {
    getState: vi.fn(),
    getTiers: vi.fn(),
    getAmountList: vi.fn(),
    pick: vi.fn(),
    flip: vi.fn(),
    deal: vi.fn(),
    noDeal: vi.fn(),
    swap: vi.fn(),
    counter: vi.fn(),
  },
}));
vi.mock('../api/user', () => ({
  userApi: { getProfile: vi.fn(), getBankerOptions: vi.fn(), updateSettings: vi.fn() },
}));
vi.mock('../api/gameSocket', () => ({
  connectGameSocket: () => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  }),
}));
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { playSfx: vi.fn() },
}));

import { matchApi, type PlayerView } from '../api/match';
import { userApi } from '../api/user';
import MatchPlayPage from './MatchPlayPage';

const STATE: PlayerView = {
  sessionId: 1,
  tier: 1,
  status: '进行',
  engineStatus: 'PICK_OWN_CARD',
  round: 0,
  flipQuota: 0,
  ownCardPosition: null,
  flippedCards: [],
  remainingCount: 26,
  currentOffer: null,
  counterUsed: false,
  timeoutDeadline: new Date(Date.now() + 300_000).toISOString(),
  settlement: null,
  settledBalanceFen: null,
  netProfitFen: null,
  entryFeeFen: 38800,
  tierMaxPrizeFen: 388800,
  startedAt: new Date().toISOString(),
  finishedAt: null,
};

afterEach(cleanup);

function renderPlayPage() {
  return render(
    <MemoryRouter initialEntries={['/match/play/1']}>
      <Routes>
        <Route path="/match/play/:sessionId" element={<MatchPlayPage />} />
        <Route path="/match/result/:sessionId" element={<div />} />
        <Route path="/lobby" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('附录 A：加载页展示银行家与用户双方角色；对局页银行家居左、用户居右', () => {
  it('对局页（/match/play）：银行家居左、用户居右（中部三区 DOM 序：银行家 → 卡牌 → 用户）', async () => {
    (matchApi.getState as ReturnType<typeof vi.fn>).mockResolvedValue(STATE);
    (matchApi.getTiers as ReturnType<typeof vi.fn>).mockResolvedValue([
      { tier: 1, name: '取款机', entryFeeFen: 38800, maxPrizeFen: 388800 },
    ]);
    (matchApi.getAmountList as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: true,
      amounts: [],
    });
    (userApi.getProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: 'u',
      nickname: null,
      signature: null,
      avatarUrl: null,
      characterUrl: '/uploads/characters/me.png',
      bankerCharacterUrl: null,
      usernameChangedAt: null,
    });
    (userApi.getBankerOptions as ReturnType<typeof vi.fn>).mockResolvedValue({
      builtin: [{ filename: 'b.png', url: '/assets/bankers/b.png' }],
      currentUrl: null,
      defaultUrl: '/assets/bankers/b.png',
    });

    const { container } = renderPlayPage();

    await waitFor(() => expect(screen.getByAltText('银行家')).toBeTruthy());
    const player = screen.getByAltText('我的角色');
    expect((player as HTMLImageElement).src).toContain('/uploads/characters/me.png');

    // 布局（3.5 三区）：银行家列 → 中央卡牌区 → 玩家列（DOM 序 = 视觉序，LTR grid）
    const imgs = container.querySelectorAll('img');
    const bankerImg = [...imgs].find((i) => i.alt === '银行家')!;
    const playerImg = [...imgs].find((i) => i.alt === '我的角色')!;
    expect(bankerImg.compareDocumentPosition(playerImg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 银行家列与玩家列互为兄弟（同一 grid 行内左右排布），中间夹中央卡牌区
    expect(bankerImg.parentElement?.parentElement?.parentElement?.parentElement).toBe(
      playerImg.parentElement?.parentElement?.parentElement?.parentElement,
    );
    // 中央卡牌区在两者之间：26 张公共牌按钮位于中列（未选底牌时全 26 张）
    const grid = bankerImg.closest('.grid');
    expect(grid).toBeTruthy();
    const children = grid!.children;
    expect(children.length).toBe(3); // 左银行家 / 中央卡牌区 / 右玩家
    expect(children[0].contains(bankerImg)).toBe(true);
    expect(children[2].contains(playerImg)).toBe(true);
    expect(children[1].querySelectorAll('button')).toHaveLength(26);
  });
});
