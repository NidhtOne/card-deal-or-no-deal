import { useCallback, useEffect, useState } from 'react';
import { economyApi, type AchievementItem } from '../api/economy';
import { getErrorMessage } from '../api/client';
import Layout from '../components/Layout';
import PageHeader from '../components/PageHeader';
import { formatMoney } from '../utils/money';

/**
 * /achievements —— 成就页（docs/开发文档.md 第四章；3.8.5 区分已领取/待领取/未解锁）。
 * 总开关 achievement_enabled=off 时整页仅提示（口径 f：后台判定照常累计，重开可见）。
 */
export default function AchievementsPage() {
  const [enabled, setEnabled] = useState(true);
  const [items, setItems] = useState<AchievementItem[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [claiming, setClaiming] = useState<string | null>(null);

  const load = useCallback(async () => {
    const view = await economyApi.getAchievements();
    setEnabled(view.enabled);
    setItems(view.list);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(getErrorMessage(err)));
  }, [load]);

  async function onClaim(code: string) {
    if (claiming) return;
    setClaiming(code);
    setError('');
    try {
      const res = await economyApi.claimAchievement(code);
      setNotice(
        res.alreadyClaimed
          ? '该成就奖励已领取'
          : `已领取成就奖励 ¥${formatMoney(res.rewardFen)}，当前余额 ¥${formatMoney(res.balanceFen)}`,
      );
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setClaiming(null);
    }
  }

  const claimed = (items ?? []).filter((a) => a.claimed);
  const unclaimed = (items ?? []).filter((a) => a.unlocked && !a.claimed);
  const locked = (items ?? []).filter((a) => !a.unlocked);

  function renderRow(a: AchievementItem, action: 'claim' | 'done' | 'locked') {
    return (
      <div
        key={a.code}
        className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
          action === 'locked'
            ? 'border-slate-800 bg-slate-900/40 opacity-60'
            : 'border-slate-700 bg-slate-900/70'
        }`}
      >
        <div>
          <div className="text-sm font-semibold text-slate-100">{a.name}</div>
          <div className="mt-0.5 text-xs text-slate-500">奖励 ¥{formatMoney(a.rewardFen)}</div>
        </div>
        {action === 'claim' && (
          <button
            onClick={() => void onClaim(a.code)}
            disabled={claiming !== null}
            className="rounded border border-amber-600 bg-amber-500/10 px-4 py-1.5 text-sm text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
          >
            {claiming === a.code ? '领取中…' : '领取'}
          </button>
        )}
        {action === 'done' && <span className="text-xs text-slate-500">已领取</span>}
        {action === 'locked' && <span className="text-xs text-slate-600">未解锁</span>}
      </div>
    );
  }

  return (
    <Layout>
      <PageHeader />
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-6">
        <h1 className="text-lg font-bold tracking-widest text-slate-200">成就</h1>

        {error && (
          <div className="rounded border border-rose-800 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded border border-emerald-800 bg-emerald-950/40 px-4 py-2 text-sm text-emerald-300">
            {notice}
          </div>
        )}

        {!enabled ? (
          /* 口径 f：总开关 off 不展示明细（后台照常累计，重开可见） */
          <p className="rounded border border-slate-800 bg-slate-900/60 px-4 py-8 text-center text-sm text-slate-500">
            成就系统已关闭，可在「设置」中重新开启
          </p>
        ) : (
          <>
            <section>
              <h2 className="mb-2 text-sm font-semibold tracking-widest text-amber-400/90">
                待领取（{unclaimed.length}）
              </h2>
              <div className="flex flex-col gap-2">
                {unclaimed.length === 0 && (
                  <p className="text-xs text-slate-600">暂无待领取成就</p>
                )}
                {unclaimed.map((a) => renderRow(a, 'claim'))}
              </div>
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold tracking-widest text-emerald-400/90">
                已领取（{claimed.length}）
              </h2>
              <div className="flex flex-col gap-2">
                {claimed.length === 0 && <p className="text-xs text-slate-600">暂无已领取成就</p>}
                {claimed.map((a) => renderRow(a, 'done'))}
              </div>
            </section>
            <section>
              <h2 className="mb-2 text-sm font-semibold tracking-widest text-slate-400">
                未解锁（{locked.length}）
              </h2>
              <div className="flex flex-col gap-2">
                {locked.map((a) => renderRow(a, 'locked'))}
              </div>
            </section>
          </>
        )}
      </div>
    </Layout>
  );
}
