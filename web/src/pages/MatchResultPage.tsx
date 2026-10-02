import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getErrorMessage } from '../api/client';
import { AudioManager } from '../audio/AudioManager';
import {
  getStartConflictSessionId,
  isHttpStatus,
  matchApi,
  type PlayerView,
  type SettleReason,
} from '../api/match';
import Layout from '../components/Layout';
import { formatMoney, formatSignedMoney } from '../utils/money';

/** 结局文案（settlement.reason；超时托管由 status 另行标注） */
const REASON_TEXT: Record<SettleReason, string> = {
  deal: '成交离场（接受银行家报价）',
  counter: '还价成交（银行家接受还价）',
  keep: '终局开牌（保留底牌）',
  swap: '终局开牌（与最后一张公共牌互换）',
};

/**
 * /match/result/:sessionId —— 结算页（文档第四章）。
 * 数据取 GET /:id/state 的 settlement / netProfitFen / settledBalanceFen 字段（任务书 §6）。
 */
export default function MatchResultPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const id = Number(sessionId);
  const navigate = useNavigate();
  const [view, setView] = useState<PlayerView | null>(null);
  const [tierName, setTierName] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) {
      navigate('/lobby', { replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      const st = await matchApi.getState(id);
      if (cancelled) return;
      if (!st.settlement) {
        // 未结算误入结算页：进行中则回对局页恢复，否则回大厅
        navigate(st.status === '进行' ? `/match/play/${id}` : '/lobby', { replace: true });
        return;
      }
      setView(st);
      AudioManager.playSfx('settle'); // 结算【文档外补充：3.9 未定义音效事件清单】
      const tiers = await matchApi.getTiers();
      if (!cancelled) setTierName(tiers.find((t) => t.tier === st.tier)?.name ?? `档位 ${st.tier}`);
    })().catch((err) => {
      if (!cancelled) setError(getErrorMessage(err));
    });
    return () => {
      cancelled = true;
    };
  }, [id, navigate]);

  /** 再来一局：同档位重新开局，clientKey 必须新生成（任务书 §6） */
  async function onPlayAgain() {
    if (!view || starting) return;
    setStarting(true);
    setError('');
    try {
      const { sessionId: newId } = await matchApi.start(view.tier, crypto.randomUUID());
      navigate(`/match/load/${newId}`);
    } catch (err) {
      const activeSessionId = getStartConflictSessionId(err);
      if (activeSessionId !== null) {
        navigate(`/match/play/${activeSessionId}`);
        return;
      }
      // 400 余额不足：按大厅逻辑提示（3.6.1 解锁判定 = 开局瞬间余额）
      setError(isHttpStatus(err, 400) ? getErrorMessage(err) : '网络异常，请重试');
    } finally {
      setStarting(false);
    }
  }

  if (error && !view) {
    return (
      <Layout>
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-sm text-rose-300">{error}</p>
          <Link
            to="/lobby"
            className="rounded border border-slate-700 px-6 py-2 text-sm text-slate-300 hover:border-amber-400 hover:text-amber-300"
          >
            返回大厅
          </Link>
        </div>
      </Layout>
    );
  }
  if (!view || !view.settlement) {
    return (
      <Layout>
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          结算数据加载中…
        </div>
      </Layout>
    );
  }

  const s = view.settlement;
  const profit = view.netProfitFen ?? s.netFen - view.entryFeeFen;
  const rows: { label: string; value: string; accent?: string }[] = [
    { label: '税前奖金', value: `¥${formatMoney(s.prizeFen)}`, accent: 'text-amber-300' },
    { label: '入场消耗', value: `¥${formatMoney(view.entryFeeFen)}` },
    { label: '盈利（税前奖金 − 入场消耗）', value: formatSignedMoney(s.profitFen) },
    { label: '税额（阶梯游戏税）', value: `¥${formatMoney(s.taxFen)}` },
    { label: '实际到手（税前奖金 − 税额）', value: `¥${formatMoney(s.netFen)}`, accent: 'text-emerald-300' },
    {
      label: '本局盈亏（实际到手 − 入场消耗）',
      value: `${formatSignedMoney(profit)} 元`,
      accent: profit > 0 ? 'text-emerald-300' : profit < 0 ? 'text-rose-400' : 'text-slate-300',
    },
  ];

  return (
    <Layout>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center gap-6 px-4 py-8">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-black tracking-widest text-amber-400">对局结算</h1>
          {view.status === '超时结算' && (
            <span className="rounded bg-rose-900/60 px-3 py-1 text-xs font-semibold text-rose-300">
              超时结算
            </span>
          )}
        </div>

        <div className="w-full overflow-hidden rounded-xl border border-slate-800">
          {rows.map((row, i) => (
            <div
              key={row.label}
              className={`flex items-center justify-between px-5 py-3 ${
                i % 2 === 0 ? 'bg-slate-900/60' : 'bg-slate-900/30'
              }`}
            >
              <span className="text-sm text-slate-400">{row.label}</span>
              <span className={`text-lg font-bold ${row.accent ?? 'text-slate-100'}`}>
                {row.value}
              </span>
            </div>
          ))}
          {view.settledBalanceFen !== null && (
            <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900/60 px-5 py-3">
              <span className="text-sm text-slate-400">结算后余额</span>
              <span className="text-lg font-bold text-sky-300">
                ¥{formatMoney(view.settledBalanceFen)}
              </span>
            </div>
          )}
        </div>

        {/* 过程摘要 */}
        <div className="w-full rounded-xl border border-slate-800 bg-slate-900/40 px-5 py-4 text-sm text-slate-400">
          <div className="mb-2 text-xs font-semibold tracking-widest text-slate-500">过程摘要</div>
          <ul className="list-inside list-disc space-y-1">
            <li>档位：{tierName || `档位 ${view.tier}`}</li>
            <li>
              进程：{view.round > 0 ? `进行至第 ${view.round} 轮，` : ''}已翻{' '}
              {view.flippedCards.length} 张 / 共 26 张
            </li>
            <li>结局：{REASON_TEXT[s.reason]}</li>
            {view.status === '超时结算' && <li>本局因 5 分钟无操作由系统自动托管完成</li>}
            {view.startedAt && (
              <li>开局时间：{new Date(view.startedAt).toLocaleString()}</li>
            )}
          </ul>
        </div>

        {error && (
          <div className="w-full rounded border border-rose-800 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        <div className="flex gap-4">
          <Link
            to="/lobby"
            className="rounded border border-slate-700 px-8 py-2.5 text-sm text-slate-300 hover:border-amber-400 hover:text-amber-300"
          >
            返回大厅
          </Link>
          <button
            onClick={() => void onPlayAgain()}
            disabled={starting}
            className="rounded bg-amber-500 px-8 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {starting ? '开局中…' : '再来一局'}
          </button>
        </div>
      </div>
    </Layout>
  );
}
