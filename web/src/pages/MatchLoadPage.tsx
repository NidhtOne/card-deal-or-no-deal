import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getErrorMessage } from '../api/client';
import { matchApi, type PlayerView } from '../api/match';
import { userApi } from '../api/user';
import Layout from '../components/Layout';
import { formatMoney } from '../utils/money';

/** 未上传用户角色图时的占位剪影（assets/placeholders，文档 3.3） */
const PLAYER_PLACEHOLDER = '/assets/placeholders/character-silhouette.png';
/** VS 动效最短展示时长（加载完成也要播完，避免闪屏） */
const MIN_SHOW_MS = 1600;

function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve(); // 单张失败不阻塞进局
    img.src = url;
  });
}

/**
 * /match/load/:sessionId —— 对局加载页（docs/开发文档.md 3.4）。
 * 银行家角色（左）vs 用户角色（右）相对而立 + VS 动效；展示档位名/入场门槛/单局最高奖金；
 * 预加载角色图（音频预加载为占位，TODO 阶段 6）；「跳过」按钮；就绪后自动进对局页。
 * 进入先拉全量状态：已结算直接跳结算页（防停留脏页面）。
 */
export default function MatchLoadPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const id = Number(sessionId);
  const navigate = useNavigate();
  const [view, setView] = useState<PlayerView | null>(null);
  const [tierName, setTierName] = useState('');
  const [bankerUrl, setBankerUrl] = useState<string | null>(null);
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) {
      navigate('/lobby', { replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      const startedAt = Date.now();
      // 先拉全量状态：已结算（含超时托管）直接跳结算页
      const st = await matchApi.getState(id);
      if (cancelled) return;
      if (st.settlement || st.status !== '进行') {
        navigate(`/match/result/${id}`, { replace: true });
        return;
      }
      setView(st);

      const [tiers, profile, bankerOptions] = await Promise.all([
        matchApi.getTiers(),
        userApi.getProfile(),
        userApi.getBankerOptions(),
      ]);
      if (cancelled) return;
      setTierName(tiers.find((t) => t.tier === st.tier)?.name ?? `档位 ${st.tier}`);
      // 银行家图：用户自定义优先，空则用内置默认（3.4）
      const banker = profile.bankerCharacterUrl ?? bankerOptions.defaultUrl;
      const player = profile.characterUrl ?? PLAYER_PLACEHOLDER;
      setBankerUrl(banker);
      setPlayerUrl(player);

      // 预加载角色图；音频预加载占位（TODO 阶段 6 接 Howler 统一管线）
      await Promise.all([banker, player].filter((u): u is string => !!u).map(preloadImage));
      // 播完 VS 动效最短时长后自动进对局
      const elapsed = Date.now() - startedAt;
      await new Promise((r) => setTimeout(r, Math.max(0, MIN_SHOW_MS - elapsed)));
      if (!cancelled) navigate(`/match/play/${id}`, { replace: true });
    })().catch((err) => {
      if (!cancelled) setError(getErrorMessage(err));
    });
    return () => {
      cancelled = true;
    };
  }, [id, navigate]);

  return (
    <Layout>
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-10">
        {error ? (
          <div className="flex flex-col items-center gap-4">
            <p className="text-sm text-rose-300">{error}</p>
            <Link to="/lobby" className="rounded border border-slate-700 px-6 py-2 text-sm text-slate-300 hover:border-amber-400 hover:text-amber-300">
              返回大厅
            </Link>
          </div>
        ) : (
          <>
            {/* 双方角色相对而立 + VS 动效（3.4） */}
            <div className="flex items-center justify-center gap-6 sm:gap-14">
              <div className="flex flex-col items-center gap-2">
                <div className="flex h-56 w-40 items-end justify-center overflow-hidden rounded-xl border border-amber-800/50 bg-slate-900">
                  {bankerUrl ? (
                    <img src={bankerUrl} alt="银行家" className="h-full w-full object-cover" />
                  ) : (
                    <div className="h-full w-full animate-pulse bg-slate-800" />
                  )}
                </div>
                <span className="text-sm font-semibold text-amber-300">银行家</span>
              </div>

              <div className="vs-pulse select-none text-5xl font-black tracking-widest text-rose-400">
                VS
              </div>

              <div className="flex flex-col items-center gap-2">
                <div className="flex h-56 w-40 items-end justify-center overflow-hidden rounded-xl border border-sky-800/50 bg-slate-900">
                  {playerUrl ? (
                    <img
                      src={playerUrl}
                      alt="我的角色"
                      className={`h-full w-full object-cover ${
                        playerUrl === PLAYER_PLACEHOLDER ? 'opacity-60' : ''
                      }`}
                    />
                  ) : (
                    <div className="h-full w-full animate-pulse bg-slate-800" />
                  )}
                </div>
                <span className="text-sm font-semibold text-sky-300">我</span>
                {/* 未上传角色图：占位剪影 + 上传入口（3.4） */}
                {playerUrl === PLAYER_PLACEHOLDER && (
                  <Link
                    to="/profile/character"
                    className="text-xs text-amber-400 underline underline-offset-2 hover:text-amber-300"
                  >
                    上传角色图
                  </Link>
                )}
              </div>
            </div>

            {/* 本局信息：档位名 / 入场门槛 / 单局最高奖金 */}
            {view && (
              <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm text-slate-300">
                <span>
                  档位：<span className="font-semibold text-amber-300">{tierName || '…'}</span>
                </span>
                <span>
                  入场门槛：
                  <span className="font-semibold text-slate-100">¥{formatMoney(view.entryFeeFen)}</span>
                </span>
                <span>
                  单局最高奖金：
                  <span className="font-semibold text-emerald-300">
                    ¥{formatMoney(view.tierMaxPrizeFen)}
                  </span>
                </span>
              </div>
            )}

            <div className="flex flex-col items-center gap-3">
              <div className="text-xs tracking-widest text-slate-500">资源加载中，即将开局…</div>
              <button
                onClick={() => navigate(`/match/play/${id}`, { replace: true })}
                className="rounded border border-slate-700 px-8 py-2 text-sm text-slate-300 hover:border-amber-400 hover:text-amber-300"
              >
                跳过
              </button>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
