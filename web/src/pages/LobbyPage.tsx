import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getErrorMessage } from '../api/client';
import {
  getStartConflictSessionId,
  isHttpStatus,
  matchApi,
  type TierInfo,
} from '../api/match';
import { userApi } from '../api/user';
import { walletApi } from '../api/wallet';
import Layout from '../components/Layout';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/auth';
import { formatMoney } from '../utils/money';

/** 风险提示文案（docs/开发文档.md 3.11 第 1 条，逐字） */
const RISK_TEXT = '提示：本游戏仅为虚拟娱乐，对局存在亏损风险，入场资金输掉不予返还，请理性游玩';

/**
 * /lobby —— 游戏大厅（文档 3.6.1 / 第四章）。
 * 档位卡片数据来自 GET /api/match/tiers（任务书 §0，铁律 7 延伸：禁止前端硬编码档位数值）；
 * 解锁状态 = 当前余额 ≥ 入场门槛（3.6.1），余额不足置灰 + tooltip；
 * 余额来自 GET /api/wallet（6.3）。
 */
export default function LobbyPage() {
  const navigate = useNavigate();
  const { user, refreshToken, clear } = useAuthStore();
  const [balanceFen, setBalanceFen] = useState<number | null>(null);
  const [tiers, setTiers] = useState<TierInfo[] | null>(null);
  const [riskPopupEnabled, setRiskPopupEnabled] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [starting, setStarting] = useState(false);
  /**
   * 开局幂等键（M2 幂等机制）：每次点击新生成 crypto.randomUUID()；
   * 同一次点击的双击被 starting 抑制，网络异常后的重试复用同一 key（防重复扣费）；
   * 成功或收到 4xx 明确驳回后置 null（key 生命周期终结）。
   */
  const startKeyRef = useRef<{ tier: number; key: string } | null>(null);

  const loadAll = useCallback(async () => {
    const [wallet, tierList, settings] = await Promise.all([
      walletApi.getWallet(),
      matchApi.getTiers(),
      userApi.getSettings(),
    ]);
    setBalanceFen(wallet.balanceFen);
    setTiers(tierList);
    setRiskPopupEnabled(settings.riskPopupEnabled);
  }, []);

  useEffect(() => {
    loadAll().catch((err) => setError(getErrorMessage(err)));
  }, [loadAll]);

  async function onLogout() {
    try {
      if (refreshToken) await api.post('/auth/logout', { refreshToken });
    } catch {
      /* 登出幂等，失败也继续清理本地状态 */
    }
    clear();
    navigate('/login', { replace: true });
  }

  async function onTierClick(tier: TierInfo) {
    if (starting) return; // 双击抑制：进行中的点击直接忽略（复用同一 key 的请求仍在飞）
    if (balanceFen === null || balanceFen < tier.entryFeeFen) return; // 未解锁（按钮已置灰，双保险）
    setError('');
    setNotice('');

    // 取款机档（tier=1，新手保底档）不弹风险提示；其余档位按设置（3.6.1/3.11）
    // TODO(阶段 6)：window.confirm 为占位实现，届时替换为正式弹窗组件
    if (tier.tier !== 1 && riskPopupEnabled && !window.confirm(RISK_TEXT)) return;

    // 重试复用同一 key：仅当上一次同档位请求的 key 已终结时才生成新 key
    if (!startKeyRef.current || startKeyRef.current.tier !== tier.tier) {
      startKeyRef.current = { tier: tier.tier, key: crypto.randomUUID() };
    }
    const { key } = startKeyRef.current;
    setStarting(true);
    try {
      const { sessionId } = await matchApi.start(tier.tier, key);
      startKeyRef.current = null;
      navigate(`/match/load/${sessionId}`);
    } catch (err) {
      const activeSessionId = getStartConflictSessionId(err);
      if (activeSessionId !== null) {
        // 409：已有进行中对局 → 提示并跳对局页恢复
        startKeyRef.current = null;
        if (window.confirm('检测到您有一局进行中的对局，是否返回继续？')) {
          navigate(`/match/play/${activeSessionId}`);
        }
      } else if (isHttpStatus(err, 400)) {
        // 400 余额不足等明确驳回：key 终结，展示服务端文案
        startKeyRef.current = null;
        setError(getErrorMessage(err));
        loadAll().catch(() => undefined); // 余额可能已被其他操作改变，刷新展示
      } else {
        // 网络异常等不确定结果：保留 key，用户重试复用（服务端幂等键防重复扣费）
        setError('网络异常，请重试（重试不会重复扣费）');
      }
    } finally {
      setStarting(false);
    }
  }

  return (
    <Layout>
      <PageHeader />
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6">
        {/* 顶栏：余额 + 账户操作 */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900/60 px-5 py-4">
          <div>
            <div className="text-xs text-slate-500">当前余额</div>
            <div className="text-2xl font-bold text-amber-300">
              {balanceFen === null ? '—' : `¥${formatMoney(balanceFen)}`}
            </div>
            <div className="mt-1 text-xs text-slate-500">{user?.username}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* 签到/任务/救助/音乐入口占位（任务书 §1：阶段 5、6 接入） */}
            {['签到', '任务', '破产救助', '音乐'].map((label) => (
              <button
                key={label}
                disabled
                title="后续阶段上线"
                className="cursor-not-allowed rounded border border-slate-800 px-4 py-2 text-sm text-slate-600"
              >
                {label}
              </button>
            ))}
            <button
              onClick={onLogout}
              className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-rose-400 hover:text-rose-300"
            >
              退出登录
            </button>
          </div>
        </div>

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

        {/* 五档场次（3.6.1） */}
        <section>
          <h2 className="mb-3 text-sm font-semibold tracking-widest text-slate-400">
            选择场次档位
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {(tiers ?? []).map((tier) => {
              const unlocked = balanceFen !== null && balanceFen >= tier.entryFeeFen;
              return (
                <button
                  key={tier.tier}
                  disabled={!unlocked || starting}
                  title={unlocked ? undefined : `余额达到 ¥${formatMoney(tier.entryFeeFen)} 解锁`}
                  onClick={() => void onTierClick(tier)}
                  className={`flex flex-col gap-2 rounded-xl border p-5 text-left transition ${
                    unlocked
                      ? 'border-amber-700/60 bg-gradient-to-b from-slate-900 to-slate-950 hover:border-amber-400 hover:shadow-[0_0_24px_rgba(251,191,36,0.15)]'
                      : 'cursor-not-allowed border-slate-800 bg-slate-900/40 opacity-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-bold text-amber-300">{tier.name}</span>
                    {!unlocked && <span className="text-xs text-slate-500">未解锁</span>}
                  </div>
                  <div className="text-xs text-slate-500">入场门槛</div>
                  <div className="text-base font-semibold text-slate-200">
                    ¥{formatMoney(tier.entryFeeFen)}
                  </div>
                  <div className="text-xs text-slate-500">单局最高奖金</div>
                  <div className="text-base font-semibold text-emerald-300">
                    ¥{formatMoney(tier.maxPrizeFen)}
                  </div>
                </button>
              );
            })}
            {tiers === null && !error && (
              <div className="col-span-full py-10 text-center text-sm text-slate-500">
                加载档位中…
              </div>
            )}
          </div>
        </section>

        <p className="text-center text-xs text-slate-600">
          对局存在亏损风险，入场资金输掉不予返还，请理性游玩
        </p>
      </div>
    </Layout>
  );
}
