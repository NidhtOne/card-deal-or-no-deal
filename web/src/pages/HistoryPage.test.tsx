// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * HistoryPage 组件测试（M5 阶段 7；docs/开发文档.md 3.10 / 第四章 /history；
 * M8【文档外补充：2026-10-03 人工决策落地】列表精简为 3 列）：
 * - 空态：0 局时统计面板全 0、列表空态文案，不报错；
 * - 渲染：统计 6 项保留 + 列表仅 3 列（对局时间/输赢金额/对局结果盈利亏损保本），
 *   其余列（档位/入场消耗/最终金额/税额/成交离场终局开牌）absent 断言；
 * - 双筛选联动重新查询（档位/结果变化触发 list 重查）；
 * - 分页（页码/上一页/下一页）。
 * 全部 API 模块 mock；金额一律分，展示层 formatMoney 转元。
 */
vi.mock('../api/history', () => ({
  historyApi: {
    list: vi.fn(),
    stats: vi.fn(),
  },
}));
vi.mock('../api/match', () => ({
  matchApi: { getTiers: vi.fn() },
}));

import { HistoryItem, HistoryList, HistoryStats, historyApi } from '../api/history';
import { matchApi } from '../api/match';
import HistoryPage from './HistoryPage';

const TIERS = [
  { tier: 1, name: '取款机', entryFeeFen: 38800, maxPrizeFen: 388800 },
  { tier: 2, name: '入门档', entryFeeFen: 200000, maxPrizeFen: 1000000 },
  { tier: 3, name: '标准档', entryFeeFen: 2000000, maxPrizeFen: 10000000 },
  { tier: 4, name: '进阶档', entryFeeFen: 8000000, maxPrizeFen: 50000000 },
  { tier: 5, name: '最高档', entryFeeFen: 22500000, maxPrizeFen: 100000000 },
];

const EMPTY_STATS: HistoryStats = {
  totalMatches: 0,
  totalNetProfitFen: 0,
  winRate: 0,
  maxNetProfitFen: 0,
  tierDistribution: TIERS.map((t) => ({ tier: t.tier, count: 0 })),
  totalTaxFen: 0,
};

const EMPTY_LIST: HistoryList = {
  items: [],
  page: 1,
  pageSize: 20,
  total: 0,
  totalPages: 1,
};

const ITEM: HistoryItem = {
  sessionId: 42,
  matchedAt: '2026-10-01 12:34',
  tier: 1,
  entryFeeFen: 38800,
  outcome: '成交离场',
  finalAmountFen: 50500,
  taxFen: 0,
  netProfitFen: 11700,
};

afterEach(cleanup);

function mockAll(stats: HistoryStats, list: HistoryList) {
  (matchApi.getTiers as ReturnType<typeof vi.fn>).mockResolvedValue(TIERS);
  (historyApi.stats as ReturnType<typeof vi.fn>).mockResolvedValue(stats);
  (historyApi.list as ReturnType<typeof vi.fn>).mockResolvedValue(list);
}

/** 文本跨嵌套 span 时的整体匹配（档位分布项：外层 span.textContent） */
function spanWithText(text: string) {
  return (_: string, el: Element | null) => el?.tagName === 'SPAN' && el.textContent === text;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/history']}>
      <HistoryPage />
    </MemoryRouter>,
  );
}

describe('HistoryPage（/history 对决历史页）', () => {
  it('空态：0 局时统计面板全 0、无报错，列表展示空态文案', async () => {
    mockAll(EMPTY_STATS, EMPTY_LIST);
    renderPage();
    // 统计 6 项全 0（不报错）
    await waitFor(() => expect(screen.getByText('0 局')).toBeTruthy());
    expect(screen.getByText('0%')).toBeTruthy();
    // 累计净盈亏 / 单局最高盈利均为 0 元（两处）
    expect(screen.getAllByText('0 元')).toHaveLength(2);
    expect(screen.getByText('暂无对局记录 —— 去大厅开局一局吧')).toBeTruthy();
    // 各档位参与分布 5 档全列（0 局；文本跨嵌套 span，用整体 textContent 匹配）
    for (const t of TIERS) {
      expect(screen.getAllByText(spanWithText(`${t.name}0 局`)).length).toBeGreaterThanOrEqual(1);
    }
    // 铁律 10 页脚声明仍在
    expect(
      screen.getByText('本游戏为纯虚拟娱乐，无任何充值与变现功能，游戏资金无现实价值'),
    ).toBeTruthy();
    // 无分页区（0 条）
    expect(screen.queryByText(/共 \d+ 条/)).toBeNull();
  });

  it('渲染：统计 6 项保留 + 列表仅 3 列，其余列 absent', async () => {
    const stats: HistoryStats = {
      totalMatches: 3,
      totalNetProfitFen: 66600,
      winRate: 0.6667,
      maxNetProfitFen: 50000,
      tierDistribution: [
        { tier: 1, count: 2 },
        { tier: 2, count: 1 },
        { tier: 3, count: 0 },
        { tier: 4, count: 0 },
        { tier: 5, count: 0 },
      ],
      totalTaxFen: 1550,
    };
    const list: HistoryList = {
      items: [
        ITEM,
        { ...ITEM, sessionId: 41, netProfitFen: -12000 },
        { ...ITEM, sessionId: 40, netProfitFen: 0 },
      ],
      page: 1,
      pageSize: 20,
      total: 3,
      totalPages: 1,
    };
    mockAll(stats, list);
    renderPage();
    // 3 列逐列渲染（对局时间 / 输赢金额 / 对局结果）
    await waitFor(() => expect(screen.getAllByText('2026-10-01 12:34').length).toBe(3));
    expect(screen.getByText('+117 元')).toBeTruthy(); // 输赢金额（+11700 分）
    expect(screen.getByText('-120 元')).toBeTruthy(); // 输赢金额（-12000 分）
    expect(screen.getByText('0 元')).toBeTruthy(); // 输赢金额（保本 0）
    expect(screen.getAllByText('盈利').length).toBeGreaterThanOrEqual(1); // 对局结果
    expect(screen.getAllByText('亏损').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('保本').length).toBeGreaterThanOrEqual(1);
    // M8 精简：表格仅 3 个列头（对局时间/输赢金额/对局结果），其余列 absent
    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['对局时间', '输赢金额', '对局结果']);
    expect(screen.queryByText('入场消耗')).toBeNull();
    expect(screen.queryByText('最终报价 / 开牌奖金')).toBeNull();
    expect(screen.queryByText('税额')).toBeNull();
    expect(screen.queryByText('成交离场')).toBeNull();
    expect(screen.queryByText('终局开牌')).toBeNull();
    expect(screen.queryByText('¥388')).toBeNull(); // 入场消耗金额
    expect(screen.queryByText('¥505')).toBeNull(); // 最终报价/开牌奖金金额
    // 统计面板（3.10 既有功能保留不动）
    expect(screen.getByText('3 局')).toBeTruthy();
    expect(screen.getByText('+666 元')).toBeTruthy(); // 累计净盈亏
    expect(screen.getByText('67%')).toBeTruthy(); // 胜率 0.6667 → 67%
    expect(screen.getByText('+500 元')).toBeTruthy(); // 单局最高盈利
    expect(screen.getByText('¥15.50')).toBeTruthy(); // 累计交税总额
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '取款机2 局')).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '入门档1 局')).toBeTruthy();
    // 分页信息
    expect(screen.getByText('共 3 条 · 第 1 / 1 页')).toBeTruthy();
  });

  it('双筛选联动重新查询：档位/结果变化触发 list 重查并重置回第 1 页', async () => {
    mockAll(EMPTY_STATS, { ...EMPTY_LIST, total: 25, totalPages: 2 });
    renderPage();
    await waitFor(() => expect(historyApi.list).toHaveBeenCalled());
    expect(historyApi.list).toHaveBeenLastCalledWith({
      tier: undefined,
      result: undefined,
      page: 1,
    });

    // 翻到第 2 页
    fireEvent.click(screen.getByText('下一页'));
    await waitFor(() =>
      expect(historyApi.list).toHaveBeenLastCalledWith({ tier: undefined, result: undefined, page: 2 }),
    );

    // 改档位筛选 → 重置第 1 页并带 tier
    const tierSelect = screen.getByLabelText('档位筛选') as HTMLSelectElement;
    fireEvent.change(tierSelect, { target: { value: '2' } });
    await waitFor(() =>
      expect(historyApi.list).toHaveBeenLastCalledWith({ tier: 2, result: undefined, page: 1 }),
    );

    // 改结果筛选 → 组合条件
    const resultSelect = screen.getByLabelText('结果筛选') as HTMLSelectElement;
    fireEvent.change(resultSelect, { target: { value: 'loss' } });
    await waitFor(() =>
      expect(historyApi.list).toHaveBeenLastCalledWith({ tier: 2, result: 'loss', page: 1 }),
    );
  });
});
