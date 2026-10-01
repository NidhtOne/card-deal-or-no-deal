import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { api, getErrorMessage } from '../api/client';
import {
  connectGameSocket,
  type FlipResultEvent,
  type MatchSettledEvent,
  type OfferReadyEvent,
  type TimeoutWarningEvent,
} from '../api/gameSocket';
import { matchApi, type AmountListView, type PlayerView } from '../api/match';
import { userApi } from '../api/user';
import CounterModal from '../components/CounterModal';
import OfferModal from '../components/OfferModal';
import Layout from '../components/Layout';
import { formatMoney } from '../utils/money';

const POOL_SIZE = 26;
/** 未上传用户角色图时的占位剪影（3.3） */
const PLAYER_PLACEHOLDER = '/assets/placeholders/character-silhouette.png';
/** 对局进行中每 30 秒 heartbeat 重置服务端 5 分钟超时（任务书 §5 / 3.6.8） */
const HEARTBEAT_MS = 30_000;
/** WS 断开降级轮询间隔（任务书 §5） */
const POLL_MS = 5_000;
/** 结算动画展示时长（随后自动跳结算页） */
const SETTLE_OVERLAY_MS = 2600;
/** 翻牌动画逐张错峰间隔 */
const FLIP_STAGGER_MS = 320;

/**
 * /match/play/:sessionId —— 对局页（布局严格按 docs/开发文档.md 3.5，状态机驱动 UI）。
 * 服务端权威（铁律 3）：一切状态以 GET /:id/state 与各命令响应的 PlayerView 为准，
 * WS 事件（offer_ready/flip_result/timeout_warning/match_settled）只作为「立即拉齐」的触发器，
 * flip_result 的 positions 仅用作逐张翻牌动画的顺序提示。
 */
export default function MatchPlayPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const id = Number(sessionId);
  const navigate = useNavigate();

  const [view, setView] = useState<PlayerView | null>(null);
  const [tierName, setTierName] = useState('');
  const [amountList, setAmountList] = useState<AmountListView | null>(null);
  const [bankerUrl, setBankerUrl] = useState<string | null>(null);
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [warnSeconds, setWarnSeconds] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [fatalError, setFatalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [counterError, setCounterError] = useState('');
  /** 面额清单开关（3.7 用户设置项；翻牌后实时划线依赖它变化时的重拉） */
  const [amountListOn, setAmountListOn] = useState(false);
  /** 报价弹窗被手动收起（关闭 ≠ 决策，底部面板作为兜底入口）；新报价出现时自动重置重新弹出 */
  const [offerModalDismissed, setOfferModalDismissed] = useState(false);
  /** 服务端已翻但逐张翻转动画尚未播到的牌位（仍展示背面） */
  const [hiddenFlips, setHiddenFlips] = useState<ReadonlySet<number>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const viewRef = useRef<PlayerView | null>(null);
  /** 已见过的已翻牌位（含动画中）：REST 响应与 WS 事件双通道去重，防重复播动画 */
  const knownFlippedRef = useRef<Set<number>>(new Set());
  /** 首次全量恢复（刷新/重进）不播翻牌动画 */
  const initializedRef = useRef(false);
  /** WS flip_result 的翻开顺序提示（applyView 消费后清空） */
  const orderHintRef = useRef<number[] | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const revealTimersRef = useRef<number[]>([]);

  /** 应用最新玩家视图：Diff 出新翻牌位并调度逐张翻转动画（首次全量恢复不播） */
  const applyView = useCallback((next: PlayerView) => {
    const known = knownFlippedRef.current;
    const fresh = next.flippedCards.filter((c) => !known.has(c.position));
    fresh.forEach((c) => known.add(c.position));

    if (initializedRef.current && fresh.length > 0) {
      const hint = orderHintRef.current;
      let ordered = fresh;
      if (hint && hint.length > 0) {
        const rank = new Map(hint.map((p, i) => [p, i]));
        ordered = [...fresh].sort(
          (a, b) => (rank.get(a.position) ?? 1_000) - (rank.get(b.position) ?? 1_000),
        );
      }
      setHiddenFlips((prev) => {
        const s = new Set(prev);
        ordered.forEach((c) => s.add(c.position));
        return s;
      });
      ordered.forEach((c, i) => {
        const timer = window.setTimeout(() => {
          setHiddenFlips((prev) => {
            const s = new Set(prev);
            s.delete(c.position);
            return s;
          });
        }, FLIP_STAGGER_MS * (i + 1));
        revealTimersRef.current.push(timer);
      });
    }
    orderHintRef.current = null;
    initializedRef.current = true;
    viewRef.current = next;
    setView(next);
  }, []);

  const refreshState = useCallback(async () => {
    const st = await matchApi.getState(id);
    applyView(st);
  }, [id, applyView]);

  /** 刷新/重进：先 GET /:id/state 全量恢复（底牌、已淘汰、轮次、当前报价、倒计时） */
  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) {
      navigate('/lobby', { replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      const st = await matchApi.getState(id);
      if (cancelled) return;
      if (st.settlement) {
        navigate(`/match/result/${id}`, { replace: true });
        return;
      }
      applyView(st);
      const [tiers, list, profile, bankerOptions] = await Promise.all([
        matchApi.getTiers(),
        matchApi.getAmountList(id),
        userApi.getProfile(),
        userApi.getBankerOptions(),
      ]);
      if (cancelled) return;
      setTierName(tiers.find((t) => t.tier === st.tier)?.name ?? `档位 ${st.tier}`);
      setAmountList(list);
      setAmountListOn(list.enabled);
      setBankerUrl(profile.bankerCharacterUrl ?? bankerOptions.defaultUrl);
      setPlayerUrl(profile.characterUrl ?? PLAYER_PLACEHOLDER);
    })().catch((err) => {
      if (!cancelled) setFatalError(getErrorMessage(err));
    });
    return () => {
      cancelled = true;
    };
  }, [id, navigate, applyView]);

  /** WS 生命周期：连接/重连对齐 state，四事件触发刷新，断线标记降级 */
  useEffect(() => {
    const socket = connectGameSocket();
    socketRef.current = socket;
    socket.on('connect', () => {
      setWsConnected(true);
      // WS 重连成功立即拉一次 state 对齐（任务书 §5）
      refreshState().catch(() => undefined);
    });
    socket.on('disconnect', () => setWsConnected(false));
    socket.on('connect_error', () => {
      // 握手鉴权失败多半是 Access 过期：借 REST 拦截器的单飞行 Refresh 刷新令牌，
      // 下一次重连由 auth 回调取新 token
      api.get('/auth/session').catch(() => undefined);
    });
    socket.on('offer_ready', (p: OfferReadyEvent) => {
      if (p.sessionId === id) refreshState().catch(() => undefined);
    });
    socket.on('flip_result', (p: FlipResultEvent) => {
      if (p.sessionId !== id) return;
      orderHintRef.current = p.positions;
      refreshState().catch(() => undefined);
    });
    socket.on('timeout_warning', (p: TimeoutWarningEvent) => {
      if (p.sessionId === id) setWarnSeconds(p.remainingSeconds);
    });
    socket.on('match_settled', (p: MatchSettledEvent) => {
      if (p.sessionId === id) refreshState().catch(() => undefined);
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [id, refreshState]);

  /** WS 断开降级：每 5 秒 GET /:id/state 轮询（任务书 §5） */
  useEffect(() => {
    if (wsConnected) return;
    const timer = window.setInterval(() => {
      const v = viewRef.current;
      if (v && !v.settlement) refreshState().catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [wsConnected, refreshState]);

  /** 对局进行中每 30 秒 heartbeat（不发则 5 分钟无操作被自动托管，3.6.8） */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const v = viewRef.current;
      if (!v || v.settlement) return;
      socketRef.current?.emit('heartbeat', { sessionId: id });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [id]);

  /** 倒计时本地秒针（以 state.timeoutDeadline 为准，每次 state 更新自动重新对齐） */
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  /** 当前报价标识（轮次+终局标记+金额）：新报价出现 → 报价弹窗重置为弹出态 */
  const offerKey = view?.currentOffer
    ? `${view.currentOffer.round}-${view.currentOffer.isFinal}-${view.currentOffer.offerFen}`
    : null;
  useEffect(() => {
    setOfferModalDismissed(false);
    setCounterOpen(false);
    setCounterError('');
  }, [offerKey]);

  /** 修复（3.6.2 已淘汰实时划线）：已翻牌数/清单开关变化即重拉面额清单 */
  const flippedCount = view?.flippedCards.length ?? 0;
  useEffect(() => {
    if (!amountListOn) return;
    matchApi
      .getAmountList(id)
      .then(setAmountList)
      .catch(() => undefined);
  }, [id, flippedCount, amountListOn]);

  /** 结算后展示开牌/成交动画，随后自动跳结算页（含 match_settled 推送触发的路径） */
  const settlement = view?.settlement ?? null;
  useEffect(() => {
    if (!settlement) return;
    const timer = window.setTimeout(
      () => navigate(`/match/result/${id}`, { replace: true }),
      SETTLE_OVERLAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [settlement, id, navigate]);

  /** 卸载清理翻牌动画定时器 */
  useEffect(
    () => () => {
      revealTimersRef.current.forEach((t) => window.clearTimeout(t));
    },
    [],
  );

  /** 命令骨架：成功后应用返回的最新 state；失败一律拉齐后端 state（如还价 400 不耗次数） */
  const runCommand = useCallback(
    async (fn: () => Promise<{ state: PlayerView }>) => {
      if (busy) return;
      setBusy(true);
      setError('');
      setWarnSeconds(null);
      try {
        const { state } = await fn();
        applyView(state);
      } catch (err) {
        setError(getErrorMessage(err));
        await refreshState().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [busy, applyView, refreshState],
  );

  function onCounterSubmit(counterFen: number) {
    void (async () => {
      if (busy) return;
      setBusy(true);
      setCounterError('');
      try {
        const { state } = await matchApi.counter(id, counterFen);
        applyView(state);
        setCounterOpen(false);
      } catch (err) {
        setCounterError(getErrorMessage(err));
        await refreshState().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    })();
  }

  async function onToggleAmountList(enabled: boolean) {
    try {
      // 面额清单开关是全局设置项（3.7），底部面板开关即写设置（3.5）
      await userApi.updateSettings({ amountListEnabled: enabled });
      setAmountListOn(enabled);
      if (!enabled) setAmountList({ enabled: false, amounts: [] });
      // 开启时由 flippedCount/开关副作用统一重拉清单，避免双请求
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (fatalError) {
    return (
      <Layout>
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-sm text-rose-300">{fatalError}</p>
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
  if (!view) {
    return (
      <Layout>
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          对局状态恢复中…
        </div>
      </Layout>
    );
  }

  // ---------- 派生数据 ----------
  const flippedMap = new Map(view.flippedCards.map((c) => [c.position, c.amountFen] as const));
  const positions = Array.from({ length: POOL_SIZE }, (_, i) => i);
  const offerPhase = view.engineStatus === 'BANKER_OFFER' || view.engineStatus === 'FINAL_OFFER';
  const remainMs = Math.max(0, Date.parse(view.timeoutDeadline) - now);
  const remainSec = Math.ceil(remainMs / 1000);
  const countdownText = `${String(Math.floor(remainSec / 60)).padStart(2, '0')}:${String(
    remainSec % 60,
  ).padStart(2, '0')}`;
  const remainingAmounts = amountList?.enabled
    ? amountList.amounts.filter((a) => !a.eliminated).map((a) => a.amountFen)
    : [];
  const minRemainingFen = remainingAmounts.length > 0 ? Math.min(...remainingAmounts) : null;
  const maxRemainingFen = remainingAmounts.length > 0 ? Math.max(...remainingAmounts) : null;
  /** SWAP_DECISION 时场上仅剩 1 张公共牌（3.6.6） */
  const lastPublicPosition = positions.find(
    (p) => p !== view.ownCardPosition && !flippedMap.has(p),
  );

  function renderCardBack(label = '?') {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-md border border-amber-800/60 bg-gradient-to-br from-slate-800 to-slate-900 text-xl font-black text-amber-700/70">
        {label}
      </div>
    );
  }

  function renderPublicCard(position: number) {
    const serverFlipped = flippedMap.has(position);
    const faceUp = serverFlipped && !hiddenFlips.has(position);
    // 选底牌：点一张封存为底牌；翻牌阶段（M3）：点一张翻一张，同款 hover 高亮/位移动效
    const picking = view!.engineStatus === 'PICK_OWN_CARD';
    const flipping = view!.engineStatus === 'FLIP_ROUND_N';
    const clickable = !busy && !serverFlipped && (picking || flipping);
    return (
      <button
        key={position}
        disabled={!clickable}
        onClick={() => {
          if (picking) void runCommand(() => matchApi.pick(id, position));
          else if (flipping) void runCommand(() => matchApi.flip(id, position));
        }}
        className={`h-20 w-14 rounded-md transition sm:h-24 sm:w-16 ${
          clickable ? 'hover:-translate-y-1 hover:shadow-[0_0_16px_rgba(251,191,36,0.35)]' : ''
        }`}
      >
        {faceUp ? (
          <div
            key={`flip-${position}`}
            className="card-flip-in flex h-full w-full flex-col items-center justify-center rounded-md border border-slate-600 bg-slate-800/80 px-1"
          >
            <span className="text-[10px] text-slate-500">已淘汰</span>
            <span className="break-all text-xs font-bold text-slate-200">
              ¥{formatMoney(flippedMap.get(position)!)}
            </span>
          </div>
        ) : (
          renderCardBack()
        )}
      </button>
    );
  }

  return (
    <Layout>
      {/* 顶部栏（3.5）：档位名 | 第 X 轮 | 已翻/剩余 | 当前最高剩余面额 | 倒计时 | WS 状态 */}
      <div className="border-b border-slate-800 bg-slate-900/60 px-4 py-2">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-1 text-sm">
          <span className="font-semibold text-amber-300">{tierName || `档位 ${view.tier}`}</span>
          <span className="text-slate-300">
            {view.round > 0 ? `第 ${view.round} 轮` : '准备阶段'}
          </span>
          <span className="text-slate-400">
            已翻 {view.flippedCards.length} 张 / 剩余 {view.remainingCount} 张
          </span>
          {/* 数据源同面额清单；amount_list_enabled=false 时随清单一并隐藏
              （文档未明确本项行为，按此默认实现 —— 待人工确认） */}
          {amountList?.enabled && maxRemainingFen !== null && (
            <span className="text-emerald-300">
              最高剩余面额 ¥{formatMoney(maxRemainingFen)}
            </span>
          )}
          <span
            className={`font-mono font-bold ${
              remainSec <= 60 ? 'animate-pulse text-rose-400' : 'text-slate-300'
            }`}
            title="超时截止时间以服务端为准，操作或心跳自动重置"
          >
            ⏱ {countdownText}
          </span>
          <span
            title={wsConnected ? '实时连接正常' : '实时连接断开，降级 5 秒轮询中'}
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              wsConnected ? 'bg-emerald-400' : 'animate-pulse bg-rose-500'
            }`}
          />
        </div>
      </div>

      {/* 超时警告（WS timeout_warning，剩余 60 秒提醒） */}
      {warnSeconds !== null && !settlement && (
        <div className="border-b border-rose-800 bg-rose-950/60 px-4 py-2 text-center text-sm font-semibold text-rose-300">
          超时警告：剩余约 {warnSeconds} 秒无任何操作将自动托管结算！
        </div>
      )}
      {error && (
        <div className="border-b border-rose-900 bg-rose-950/40 px-4 py-2 text-center text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* 中部三区（3.5）：左银行家 / 中央卡牌区 / 右玩家 */}
      <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-[auto_1fr_auto] gap-4 px-4 py-4">
        {/* 银行家（左）：报价阶段高亮 + 说话气泡 */}
        <div className="flex w-36 flex-col items-center gap-2 sm:w-44">
          <div
            className={`relative flex h-48 w-full items-end justify-center overflow-hidden rounded-xl border bg-slate-900 transition sm:h-64 ${
              offerPhase
                ? 'banker-glow border-amber-400'
                : 'border-slate-800'
            }`}
          >
            {bankerUrl ? (
              <img src={bankerUrl} alt="银行家" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full animate-pulse bg-slate-800" />
            )}
          </div>
          <span className="text-sm font-semibold text-amber-300">银行家</span>
          {offerPhase && view.currentOffer && (
            <div className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-center text-xs text-amber-200">
              {view.currentOffer.isFinal ? '终极报价！' : '我的报价：'}
              <div className="text-lg font-black">¥{formatMoney(view.currentOffer.offerFen)}</div>
            </div>
          )}
        </div>

        {/* 中央卡牌区 */}
        <div className="relative flex flex-col items-center gap-4">
          {/* 报价传递动效（3.5：电话/信封意象，报价更新时重播） */}
          {offerPhase && offerKey && (
            <div key={offerKey} className="pointer-events-none absolute -top-1 left-0 text-2xl">
              <span className="envelope-fly inline-block">✉</span>
            </div>
          )}

          {view.engineStatus === 'PICK_OWN_CARD' && (
            <div className="rounded border border-sky-800 bg-sky-950/40 px-4 py-2 text-sm text-sky-300">
              选择 1 张牌作为本局底牌
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            {positions.filter((p) => p !== view.ownCardPosition).map(renderPublicCard)}
          </div>

          {/* 我的底牌（背面，封存，单独展示） */}
          {view.ownCardPosition !== null && (
            <div className="mt-2 flex flex-col items-center gap-1">
                <div className="h-24 w-16 rounded-md ring-2 ring-sky-500/60">
                  {settlement ? (
                    <div className="card-flip-in flex h-full w-full flex-col items-center justify-center rounded-md border border-sky-600 bg-sky-950/60 px-1">
                      <span className="text-[10px] text-sky-400">底牌</span>
                      <span className="text-xs font-black text-sky-200">
                        ¥{formatMoney(settlement.prizeFen)}
                      </span>
                    </div>
                  ) : (
                    renderCardBack('我')
                  )}
                </div>
              <span className="text-xs text-slate-500">我的底牌（封存）</span>
            </div>
          )}

          {/* 翻牌（M3 逐张点击）：未翻开的公共牌直接点击；配额耗尽瞬间服务端生成本轮报价 */}
          {view.engineStatus === 'FLIP_ROUND_N' && (
            <div className="rounded border border-amber-800 bg-amber-950/40 px-4 py-2 text-sm text-amber-300">
              点击任意未翻开的牌翻开它，本轮还需翻 {view.flipQuota} 张
            </div>
          )}

          {/* 终局换牌决策（3.6.6：保留底牌 / 换最后一张公共牌，二选一） */}
          {view.engineStatus === 'SWAP_DECISION' && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/70 p-4">
              <div className="text-sm font-semibold text-slate-200">
                终局决策：保留底牌，或与最后一张公共牌互换？
              </div>
              <div className="flex items-center gap-6">
                <div className="flex flex-col items-center gap-1">
                  <div className="h-24 w-16">{renderCardBack('我')}</div>
                  <button
                    onClick={() => void runCommand(() => matchApi.swap(id, false))}
                    disabled={busy}
                    className="rounded bg-sky-600 px-4 py-2 text-sm font-semibold hover:bg-sky-500 disabled:opacity-50"
                  >
                    保留底牌
                  </button>
                </div>
                <div className="text-xl text-slate-500">⇄</div>
                <div className="flex flex-col items-center gap-1">
                  <div className="h-24 w-16">
                    {lastPublicPosition !== undefined && renderCardBack()}
                  </div>
                  <button
                    onClick={() => void runCommand(() => matchApi.swap(id, true))}
                    disabled={busy || lastPublicPosition === undefined}
                    className="rounded bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
                  >
                    换这张公共牌
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 玩家（右）：操作时反馈动效 */}
        <div className="flex w-36 flex-col items-center gap-2 sm:w-44">
          <div
            className={`flex h-48 w-full items-end justify-center overflow-hidden rounded-xl border bg-slate-900 transition sm:h-64 ${
              busy ? 'player-act border-sky-400' : 'border-slate-800'
            }`}
          >
            <img
              src={playerUrl ?? PLAYER_PLACEHOLDER}
              alt="我的角色"
              className={`h-full w-full object-cover ${
                (playerUrl ?? PLAYER_PLACEHOLDER) === PLAYER_PLACEHOLDER ? 'opacity-60' : ''
              }`}
            />
          </div>
          <span className="text-sm font-semibold text-sky-300">我</span>
          {(playerUrl ?? PLAYER_PLACEHOLDER) === PLAYER_PLACEHOLDER && (
            <Link
              to="/profile/character"
              className="text-xs text-amber-400 underline underline-offset-2 hover:text-amber-300"
            >
              上传角色图
            </Link>
          )}
        </div>
      </div>

      {/* 面额清单（3.6.2：受开关控制，已淘汰实时划线，不揭示位置对应关系） */}
      {amountList?.enabled && (
        <div className="border-t border-slate-800 bg-slate-950/80 px-4 py-2">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-1.5">
            {amountList.amounts.map((a) => (
              <span
                key={a.amountFen}
                className={`rounded px-2 py-0.5 text-xs ${
                  a.eliminated
                    ? 'text-slate-600 line-through'
                    : 'bg-slate-900 font-semibold text-slate-200'
                }`}
              >
                ¥{formatMoney(a.amountFen)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 底部面板（3.5）：当前报价 | [成交][还价][拒绝] | 面额清单开关 */}
      <div className="border-t border-slate-800 bg-slate-900/60 px-4 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-400">
            当前报价：
            {view.currentOffer ? (
              <span className="text-lg font-black text-amber-300">
                ¥{formatMoney(view.currentOffer.offerFen)}
                {view.currentOffer.isFinal && (
                  <span className="ml-2 rounded bg-rose-900/60 px-2 py-0.5 text-xs text-rose-300">
                    终极报价
                  </span>
                )}
              </span>
            ) : (
              <span className="text-slate-600">—</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void runCommand(() => matchApi.deal(id))}
              disabled={!offerPhase || busy}
              className="rounded bg-emerald-600 px-6 py-2 text-sm font-bold hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              成交
            </button>
            <button
              onClick={() => {
                setCounterError('');
                setCounterOpen(true);
              }}
              disabled={!offerPhase || busy || view.counterUsed}
              title={view.counterUsed ? '本轮还价机会已用完（3.6.5 每轮限 1 次）' : undefined}
              className="rounded bg-amber-500 px-6 py-2 text-sm font-bold text-slate-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              还价{view.counterUsed ? '（本轮已用）' : ''}
            </button>
            <button
              onClick={() => void runCommand(() => matchApi.noDeal(id))}
              disabled={!offerPhase || busy}
              className="rounded bg-rose-600 px-6 py-2 text-sm font-bold hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              拒绝
            </button>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={amountListOn}
              onChange={(e) => void onToggleAmountList(e.target.checked)}
              className="accent-amber-400"
            />
            面额清单
          </label>
        </div>
      </div>

      {/* 银行家报价弹窗（产品确认新增 —— 与文档 3.5 底部按钮布局并存：
          底部面板保留为兜底入口；弹窗与面板共用同一 view.currentOffer 数据源，
          关闭弹窗 ≠ 决策；busy 期间按钮禁用，失败一律 runCommand 拉齐后端 state） */}
      {offerPhase && view.currentOffer && !offerModalDismissed && !settlement && (
        <OfferModal
          key={offerKey}
          offerFen={view.currentOffer.offerFen}
          isFinal={view.currentOffer.isFinal}
          bankerUrl={bankerUrl}
          counterUsed={view.counterUsed}
          busy={busy}
          onDeal={() => void runCommand(() => matchApi.deal(id))}
          onCounter={() => {
            setCounterError('');
            setCounterOpen(true);
          }}
          onNoDeal={() => void runCommand(() => matchApi.noDeal(id))}
          onClose={() => setOfferModalDismissed(true)}
        />
      )}

      {/* 还价弹窗（3.6.5 / 任务书 §4） */}
      {counterOpen && view.currentOffer && (
        <CounterModal
          minRemainingFen={minRemainingFen}
          maxPrizeFen={view.tierMaxPrizeFen}
          currentOfferFen={view.currentOffer.offerFen}
          submitting={busy}
          serverError={counterError}
          onSubmit={onCounterSubmit}
          onClose={() => setCounterOpen(false)}
        />
      )}

      {/* 结算动画覆盖层：成交/开牌后自动跳结算页 */}
      {settlement && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-amber-700/60 bg-slate-900 px-10 py-8 text-center">
            {view.status === '超时结算' && (
              <span className="rounded bg-rose-900/60 px-3 py-1 text-xs font-semibold text-rose-300">
                超时结算（5 分钟无操作自动托管）
              </span>
            )}
            <div className="text-xl font-bold text-slate-200">
              {settlement.reason === 'deal' || settlement.reason === 'counter' ? '成交！' : '开牌！'}
            </div>
            <div className="text-4xl font-black text-amber-300">
              ¥{formatMoney(settlement.prizeFen)}
            </div>
            <div className="text-xs text-slate-500">正在前往结算页…</div>
          </div>
        </div>
      )}
    </Layout>
  );
}
