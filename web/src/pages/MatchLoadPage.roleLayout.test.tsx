// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 对局加载页角色展示测试 —— 附录 A 条目原文：
 * 「加载页展示银行家与用户双方角色；对局页银行家居左、用户居右」
 * （本文件覆盖前半句「加载页展示银行家与用户双方角色」；对局页左右布局见
 *  MatchPlayPage.roleLayout.test.tsx；真实浏览器全流程另见 Playwright test:e2e）。
 * 断言：双方角色图同时渲染（alt=银行家 / alt=我的角色），且银行家在文档流中居左
 * （DOM 顺序在前；页面为 LTR flex 布局，DOM 序 = 视觉序）。
 */
vi.mock('../api/match', () => ({
  matchApi: { getState: vi.fn(), getTiers: vi.fn() },
}));
vi.mock('../api/user', () => ({
  userApi: { getProfile: vi.fn(), getBankerOptions: vi.fn() },
}));

import { matchApi, type PlayerView } from '../api/match';
import { userApi } from '../api/user';
import MatchLoadPage from './MatchLoadPage';

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

function renderLoadPage() {
  return render(
    <MemoryRouter initialEntries={['/match/load/1']}>
      <Routes>
        <Route path="/match/load/:sessionId" element={<MatchLoadPage />} />
        <Route path="/match/play/:sessionId" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('附录 A：加载页展示银行家与用户双方角色；对局页银行家居左、用户居右', () => {
  it('加载页（/match/load）：银行家与用户双方角色同时展示，银行家居左、用户居右', async () => {
    (matchApi.getState as ReturnType<typeof vi.fn>).mockResolvedValue(STATE);
    (matchApi.getTiers as ReturnType<typeof vi.fn>).mockResolvedValue([
      { tier: 1, name: '取款机', entryFeeFen: 38800, maxPrizeFen: 388800 },
    ]);
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

    const { container } = renderLoadPage();

    // 双方角色均渲染（银行家用内置默认、用户角色为自行上传的 characterUrl）
    await waitFor(() => expect(screen.getByAltText('银行家')).toBeTruthy());
    expect(screen.getByAltText('我的角色')).toBeTruthy();
    expect((screen.getByAltText('我的角色') as HTMLImageElement).src).toContain(
      '/uploads/characters/me.png',
    );

    // 布局：银行家居左（DOM 序在前）、VS 居中、用户居右（LTR flex，DOM 序 = 视觉序）
    const imgs = container.querySelectorAll('img');
    const bankerIdx = [...imgs].findIndex((i) => i.alt === '银行家');
    const playerIdx = [...imgs].findIndex((i) => i.alt === '我的角色');
    expect(bankerIdx).toBeGreaterThanOrEqual(0);
    expect(playerIdx).toBeGreaterThan(bankerIdx);
    expect(screen.getByText('VS')).toBeTruthy();
  });

  it('未上传用户角色图时展示占位剪影，不缺失展示位（3.3）', async () => {
    (matchApi.getState as ReturnType<typeof vi.fn>).mockResolvedValue(STATE);
    (matchApi.getTiers as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (userApi.getProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: 'u',
      nickname: null,
      signature: null,
      avatarUrl: null,
      characterUrl: null,
      bankerCharacterUrl: null,
      usernameChangedAt: null,
    });
    (userApi.getBankerOptions as ReturnType<typeof vi.fn>).mockResolvedValue({
      builtin: [{ filename: 'b.png', url: '/assets/bankers/b.png' }],
      currentUrl: null,
      defaultUrl: '/assets/bankers/b.png',
    });

    renderLoadPage();
    await waitFor(() => expect(screen.getByAltText('银行家')).toBeTruthy());
    const player = screen.getByAltText('我的角色') as HTMLImageElement;
    expect(player.src).toContain('/assets/placeholders/character-silhouette.png');
    // 占位剪影附带上传引导入口
    expect(screen.getByText('上传角色图')).toBeTruthy();
  });
});
