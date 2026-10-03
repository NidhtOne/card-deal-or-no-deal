import { useCallback, useEffect, useState } from 'react';
import { getErrorMessage } from '../api/client';
import { HistoryList, HistoryResultFilter, HistoryStats, historyApi } from '../api/history';
import { matchApi, type TierInfo } from '../api/match';
import Layout from '../components/Layout';
import PageHeader from '../components/PageHeader';
import { formatMoney, formatSignedMoney } from '../utils/money';

/**
 * /history —— 对决历史（docs/开发文档.md 3.10 / 第四章：列表 + 筛选 + 统计面板）。
 * - 顶部统计面板 6 项（GET /api/history/stats）；0 局时全部展示 0，不报错（空态口径）；
 * - M8【文档外补充：2026-10-03 人工决策落地】列表仅保留 3 列：对局时间、输赢金额、
 *   对局结果（盈利/亏损/保本）——人工决策限定「列表展示字段」，其余列（档位/入场消耗/
 *   最终金额/税额）移除【口径钦定，待人工过目】；既有「档位/结果」筛选器与顶部统计卡
 *   为开发文档 3.10 既有功能，保留不动【待人工过目】；
 * - sessionId 仅为行 key；分页与 API 契约不动（只改展示层）；
 * - 本阶段不做「详情展开/过程摘要」：过程明细（翻牌/报价序列）暂无持久化数据源，
 *   知识库未定义，待人工决策后另行排期（禁止脑补表结构）。
 */

const RESULT_OPTIONS: { value: HistoryResultFilter; label: string }[] = [
  { value: 'profit', label: '盈利' },
  { value: 'even', label: '保本' },
  { value: 'loss', label: '亏损' },
];

export default function HistoryPage() {
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [list, setList] = useState<HistoryList | null>(null);
  const [tiers, setTiers] = useState<TierInfo[] | null>(null);
  /** 双筛选 + 页码（服务端权威：改动即触发重新查询） */
  const [tierFilter, setTierFilter] = useState<number | ''>('');
  const [resultFilter, setResultFilter] = useState<HistoryResultFilter | ''>('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const query = useCallback(async () => {
    setLoading(true);
    try {
      const [s, l] = await Promise.all([
        historyApi.stats(),
        historyApi.list({
          tier: tierFilter === '' ? undefined : tierFilter,
          result: resultFilter === '' ? undefined : resultFilter,
          page,
        }),
      ]);
      setStats(s);
      setList(l);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [tierFilter, resultFilter, page]);

  useEffect(() => {
    query().catch(() => undefined);
    // 筛选变化时重置回第 1 页（联动重新查询）
  }, [query]);

  useEffect(() => {
    matchApi
      .getTiers()
      .then(setTiers)
      .catch(() => undefined);
  }, []);

  const tierName = useCallback(
    (tier: number) => tiers?.find((t) => t.tier === tier)?.name ?? `档位 ${tier}`,
    [tiers],
  );

  /** 对局结果列（盈利/亏损/保本）：从输赢金额推导【文档外补充：2026-10-03 人工决策落地】 */
  const outcomeLabel = useCallback(
    (netProfitFen: number) =>
      netProfitFen > 0 ? '盈利' : netProfitFen < 0 ? '亏损' : '保本',
    [],
  );

  function onTierChange(value: number | '') {
    setTierFilter(value);
    setPage(1);
  }

  function onResultChange(value: HistoryResultFilter | '') {
    setResultFilter(value);
    setPage(1);
  }

  return (
    <Layout>
      <PageHeader />
      <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <h1 className="mb-6 text-2xl font-bold text-amber-300">对决历史</h1>

        {error && (
          <div className="mb-4 rounded border border-rose-800 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        {/* 统计面板（3.10 六项；0 局时全 0 不报错） */}
        <section className="mb-6 rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="累计对局" value={stats ? `${stats.totalMatches} 局` : '—'} />
            <StatCard
              label="累计净盈亏"
              value={stats ? `${formatSignedMoney(stats.totalNetProfitFen)} 元` : '—'}
              accent={
                stats ? (stats.totalNetProfitFen > 0 ? 'up' : stats.totalNetProfitFen < 0 ? 'down' : 'flat') : 'flat'
              }
            />
            <StatCard
              label="总体胜率"
              value={stats ? `${Math.round(stats.winRate * 100)}%` : '—'}
            />
            <StatCard
              label="单局最高盈利"
              value={stats ? `${formatSignedMoney(stats.maxNetProfitFen)} 元` : '—'}
            />
            <StatCard
              label="累计交税总额"
              value={stats ? `¥${formatMoney(stats.totalTaxFen)}` : '—'}
            />
          </div>
          {/* 各档位参与分布（第 6 项） */}
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-slate-800 pt-4 text-sm">
            <span className="text-xs text-slate-500">各档位参与分布</span>
            {stats
              ? stats.tierDistribution.map((d) => (
                  <span key={d.tier} className="text-slate-300">
                    {tierName(d.tier)}
                    <span className="ml-1 font-semibold text-amber-300">{d.count}</span> 局
                  </span>
                ))
              : '—'}
          </div>
        </section>

        {/* 双筛选（档位 / 结果），联动重新查询 */}
        <section className="mb-4 flex flex-wrap items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/60 px-5 py-3">
          <label className="flex items-center gap-2 text-sm text-slate-400">
            档位
            <select
              aria-label="档位筛选"
              value={tierFilter}
              onChange={(e) => onTierChange(e.target.value === '' ? '' : Number(e.target.value))}
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-amber-400"
            >
              <option value="">全部</option>
              {(tiers ?? []).map((t) => (
                <option key={t.tier} value={t.tier}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-400">
            结果
            <select
              aria-label="结果筛选"
              value={resultFilter}
              onChange={(e) =>
                onResultChange(e.target.value === '' ? '' : (e.target.value as HistoryResultFilter))
              }
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-amber-400"
            >
              <option value="">全部</option>
              {RESULT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {loading && <span className="text-xs text-slate-500">查询中…</span>}
        </section>

        {/* 列表（M8 精简为 3 列：对局时间 / 输赢金额 / 对局结果） */}
        <section className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="bg-slate-900/80 text-left text-xs text-slate-500">
                <th className="px-4 py-3">对局时间</th>
                <th className="px-4 py-3">输赢金额</th>
                <th className="px-4 py-3">对局结果</th>
              </tr>
            </thead>
            <tbody>
              {list?.items.map((item) => (
                <tr
                  key={item.sessionId}
                  className="border-t border-slate-800 bg-slate-950/40"
                >
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {item.matchedAt}
                  </td>
                  <td
                    className={`px-4 py-3 font-semibold ${
                      item.netProfitFen > 0
                        ? 'text-emerald-300'
                        : item.netProfitFen < 0
                          ? 'text-rose-400'
                          : 'text-slate-300'
                    }`}
                  >
                    {formatSignedMoney(item.netProfitFen)} 元
                  </td>
                  <td className="px-4 py-3 text-slate-300">{outcomeLabel(item.netProfitFen)}</td>
                </tr>
              ))}
              {list && list.items.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-slate-500">
                    暂无对局记录 —— 去大厅开局一局吧
                  </td>
                </tr>
              )}
              {!list && (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-slate-500">
                    加载中…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        {/* 分页 */}
        {list && list.total > 0 && (
          <div className="mt-4 flex items-center justify-between text-sm text-slate-400">
            <span>
              共 {list.total} 条 · 第 {list.page} / {list.totalPages} 页
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={list.page <= 1 || loading}
                className="rounded border border-slate-700 px-4 py-1.5 hover:border-amber-400 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                上一页
              </button>
              <button
                onClick={() => setPage((p) => Math.min(list.totalPages, p + 1))}
                disabled={list.page >= list.totalPages || loading}
                className="rounded border border-slate-700 px-4 py-1.5 hover:border-amber-400 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

/** M8【文档外补充】：旧 7 字段行组件已按人工决策移除，列表仅保留 3 列。 */

function StatCard({
  label,
  value,
  accent = 'flat',
}: {
  label: string;
  value: string;
  accent?: 'up' | 'down' | 'flat';
}) {
  const accentClass =
    accent === 'up' ? 'text-emerald-300' : accent === 'down' ? 'text-rose-400' : 'text-slate-100';
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${accentClass}`}>{value}</p>
    </div>
  );
}
