import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getErrorMessage } from '../api/client';
import {
  economyApi,
  type AchievementItem,
  type SigninResult,
  type TaskItem,
} from '../api/economy';
import {
  getStartConflictSessionId,
  isHttpStatus,
  matchApi,
  type TierInfo,
} from '../api/match';
import { userApi, type Overview } from '../api/user';
import { walletApi } from '../api/wallet';
import Layout from '../components/Layout';
import PageHeader from '../components/PageHeader';
import RiskPopup from '../components/RiskPopup';
import {
  RISK_TEXT_BAILOUT,
  RISK_TEXT_ENTRY,
  shouldShowBailoutReminder,
  shouldShowEntryRisk,
} from '../components/riskPopupText';
import { useAuthStore } from '../store/auth';
import { formatMoney } from '../utils/money';

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
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [starting, setStarting] = useState(false);
  /** 风险提示弹窗（3.11 触发点 1）：待确认开局的目标档位；非 null 即弹窗 */
  const [pendingTier, setPendingTier] = useState<TierInfo | null>(null);
  /** 风险提示弹窗（3.11 触发点 2）：第 2/3 次破产救助提醒 */
  const [showBailoutReminder, setShowBailoutReminder] = useState(false);
  // M4：签到/任务/救助/成就（入口原为占位，现为真实逻辑；「音乐」不在本阶段，仍占位）
  const [showSignin, setShowSignin] = useState(false);
  const [signinResult, setSigninResult] = useState<SigninResult | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [claimingTask, setClaimingTask] = useState<string | null>(null);
  const [applyingBailout, setApplyingBailout] = useState(false);
  // 【触发时点文档未定义，按此口径注释标注】待领取成就进入大厅时弹出（一键领取）
  const [unclaimedAchievements, setUnclaimedAchievements] = useState<AchievementItem[]>([]);
  const [claimingAchievement, setClaimingAchievement] = useState(false);
  /**
   * 开局幂等键（M2 幂等机制）：每次点击新生成 crypto.randomUUID()；
   * 同一次点击的双击被 starting 抑制，网络异常后的重试复用同一 key（防重复扣费）；
   * 成功或收到 4xx 明确驳回后置 null（key 生命周期终结）。
   */
  const startKeyRef = useRef<{ tier: number; key: string } | null>(null);

  const loadAll = useCallback(async () => {
    const [wallet, tierList, settings, ov, achievements] = await Promise.all([
      walletApi.getWallet(),
      matchApi.getTiers(),
      userApi.getSettings(),
      userApi.getOverview(),
      economyApi.getAchievements(),
    ]);
    setBalanceFen(wallet.balanceFen);
    setTiers(tierList);
    setRiskPopupEnabled(settings.riskPopupEnabled);
    setOverview(ov);
    // 口径 f（注释标注）：总开关 off 时不弹窗（后台照常累计，重开可见）
    if (achievements.enabled) {
      setUnclaimedAchievements(achievements.list.filter((a) => a.unlocked && !a.claimed));
    }
  }, []);

  useEffect(() => {
    loadAll().catch((err) => setError(getErrorMessage(err)));
  }, [loadAll]);

  // ---------- M4：签到 ----------
  async function onOpenSignin() {
    setShowSignin(true);
    setSigninResult(null);
  }

  async function onSignin() {
    if (signingIn) return;
    setSigningIn(true);
    setError('');
    try {
      const res = await economyApi.signin();
      // 幂等：重复提交 res.signed=false 且返回既有奖励，流水仅一条
      setSigninResult(res);
      setBalanceFen(res.balanceFen);
      await loadAll().catch(() => undefined);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSigningIn(false);
    }
  }

  // ---------- M4：每日任务 ----------
  async function onOpenTasks() {
    setShowTasks(true);
    try {
      const view = await economyApi.getTasks();
      setTasks(view.tasks);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function onClaimTask(code: string) {
    if (claimingTask) return;
    setClaimingTask(code);
    setError('');
    try {
      const res = await economyApi.claimTask(code);
      setNotice(
        res.alreadyClaimed
          ? '任务奖励已领取'
          : `已领取任务奖励 ¥${formatMoney(res.rewardFen)}`,
      );
      setBalanceFen(res.balanceFen);
      const view = await economyApi.getTasks();
      setTasks(view.tasks);
      await loadAll().catch(() => undefined);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setClaimingTask(null);
    }
  }

  // ---------- M4：破产救助（3.8.4；needsReminder 弹窗 UI 已在阶段 6 接入，受 risk_popup_enabled 控制） ----------
  async function onBailout() {
    if (applyingBailout) return;
    setApplyingBailout(true);
    setError('');
    try {
      const res = await economyApi.applyBailout();
      setBalanceFen(res.balanceFen);
      setNotice(
        `破产救助已到账 ¥${formatMoney(res.amountFen)}，今日剩余 ${res.remaining} 次`,
      );
      // 3.11 触发点 2：当日第 2/3 次申请（needsReminder=true）弹提醒，受全局开关控制
      if (shouldShowBailoutReminder(res.needsReminder, riskPopupEnabled)) {
        setShowBailoutReminder(true);
      }
      await loadAll().catch(() => undefined);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setApplyingBailout(false);
    }
  }

  // ---------- M4：待领取成就一键领取 ----------
  async function onClaimAllAchievements() {
    if (claimingAchievement) return;
    setClaimingAchievement(true);
    setError('');
    try {
      let lastBalance: number | null = null;
      for (const a of unclaimedAchievements) {
        const res = await economyApi.claimAchievement(a.code);
        lastBalance = res.balanceFen;
      }
      if (lastBalance !== null) setBalanceFen(lastBalance);
      setUnclaimedAchievements([]);
      setNotice('成就奖励已全部领取');
      await loadAll().catch(() => undefined);
    } catch (err) {
      setError(getErrorMessage(err));
      const view = await economyApi.getAchievements().catch(() => null);
      if (view) setUnclaimedAchievements(view.list.filter((a) => a.unlocked && !a.claimed));
    } finally {
      setClaimingAchievement(false);
    }
  }

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

    // 风险提示弹窗（3.11 触发点 1）：非取款机档（tier=1 不提示）且开关开 →
    // 确认后才调 /api/match/start；取消留在原页不调 start。off 时跳过弹窗直接开局（逻辑等价）。
    if (shouldShowEntryRisk(tier.tier, riskPopupEnabled)) {
      setPendingTier(tier);
      return;
    }
    await doStart(tier);
  }

  /** 真正的开局流程（风险弹窗确认后 / 无需提示时进入） */
  async function doStart(tier: TierInfo) {
    if (starting) return;
    setError('');
    setNotice('');

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
            {/* 签到入口（M4 真实逻辑；连签天数展示） */}
            <button
              onClick={() => void onOpenSignin()}
              className="rounded border border-amber-700/60 bg-amber-500/10 px-4 py-2 text-sm text-amber-300 hover:bg-amber-500/20"
            >
              签到
              {overview && (
                <span className="ml-1 text-xs text-amber-200/80">
                  {overview.todaySignedIn
                    ? `已签·连签 ${overview.signinStreakDays} 天`
                    : overview.signinStreakDays > 0
                      ? `未签·连签 ${overview.signinStreakDays} 天`
                      : '未签'}
                </span>
              )}
            </button>
            {/* 每日任务入口（M4 真实逻辑：进度 + 领奖面板） */}
            <button
              onClick={() => void onOpenTasks()}
              className="rounded border border-sky-700/60 bg-sky-500/10 px-4 py-2 text-sm text-sky-300 hover:bg-sky-500/20"
            >
              任务
            </button>
            {/* 破产救助入口（M4 真实逻辑：3.8.4 仅余额低于门槛可申请，本阶段仅入口高亮展示） */}
            <button
              onClick={() => void onBailout()}
              disabled={!overview?.bailoutEligible || applyingBailout}
              title={
                overview?.bailoutEligible
                  ? `每次 ¥500，每日最多 ${overview.bailoutMaxPerDay} 次（今日已用 ${overview.todayBailoutUsed} 次）`
                  : '余额低于 ¥388 时可申请破产救助'
              }
              className={
                overview?.bailoutEligible
                  ? 'rounded border border-rose-600 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20'
                  : 'cursor-not-allowed rounded border border-slate-800 px-4 py-2 text-sm text-slate-600'
              }
            >
              破产救助
              {overview && overview.todayBailoutUsed > 0 && (
                <span className="ml-1 text-xs">
                  {overview.todayBailoutUsed}/{overview.bailoutMaxPerDay}
                </span>
              )}
            </button>
            {/* 音乐入口不在本阶段（属 M3 后续打磨），仍占位 */}
            <button
              disabled
              title="后续阶段上线"
              className="cursor-not-allowed rounded border border-slate-800 px-4 py-2 text-sm text-slate-600"
            >
              音乐
            </button>
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

      {/* 签到弹窗（M4）—— 连胜进度以圆点条展示（日历视图为产品新增，注释标注） */}
      {showSignin && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-bold text-amber-300">每日签到</h3>
              <button
                onClick={() => setShowSignin(false)}
                className="text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>
            {signinResult ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-slate-200">
                  {signinResult.signed ? '签到成功！' : '今日已签到，请勿重复提交'}
                  奖励 ¥{formatMoney(signinResult.rewardFen)}（×
                  {signinResult.multiplierBp / 10000}）
                </p>
                <p className="text-xs text-slate-500">
                  连签 {signinResult.streakDays} 天 · 明日可领 ¥
                  {formatMoney(signinResult.nextRewardFen)}
                </p>
                {/* 连胜圆点条（日历视图产品新增）：7 点为连签档位进度（第 7 天起封顶） */}
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: 7 }, (_, i) => (
                    <span
                      key={i}
                      className={`h-2.5 w-2.5 rounded-full ${
                        i < Math.min(signinResult.streakDays, 7)
                          ? 'bg-amber-400'
                          : 'bg-slate-700'
                      }`}
                    />
                  ))}
                  <span className="ml-1 text-xs text-slate-500">7 天起锁定 ×2.0</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-slate-300">
                  {overview?.todaySignedIn
                    ? `今日已签到，连签 ${overview.signinStreakDays} 天`
                    : overview && overview.signinStreakDays > 0
                      ? `今日尚未签到（当前连签 ${overview.signinStreakDays} 天）`
                      : '今日尚未签到'}
                </p>
                <p className="text-xs text-slate-500">
                  断签次日连签清零；00:00 刷新，不可补签。
                </p>
                {!overview?.todaySignedIn && (
                  <button
                    onClick={() => void onSignin()}
                    disabled={signingIn}
                    className="rounded-lg bg-amber-500 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
                  >
                    {signingIn ? '签到中…' : '立即签到'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 每日任务面板（M4） */}
      {showTasks && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-slate-700 bg-slate-900 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-bold text-sky-300">每日任务</h3>
              <button
                onClick={() => setShowTasks(false)}
                className="text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>
            <p className="mb-3 text-xs text-slate-500">
              每日 00:00 刷新，未领取奖励次日失效。
            </p>
            <div className="flex flex-col gap-2 overflow-y-auto">
              {(tasks ?? []).map((t) => (
                <div
                  key={t.code}
                  className="flex items-center justify-between rounded-lg border border-slate-700/70 bg-slate-950/60 px-3 py-2"
                >
                  <div>
                    <div className="text-sm text-slate-100">
                      {t.name}
                      <span className="ml-2 text-xs text-amber-300/90">
                        ¥{formatMoney(t.rewardFen)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {t.requirement} · 进度 {Math.min(t.progress, t.target)}/{t.target}
                    </div>
                  </div>
                  {t.claimed ? (
                    <span className="text-xs text-slate-500">已领取</span>
                  ) : t.claimable ? (
                    <button
                      onClick={() => void onClaimTask(t.code)}
                      disabled={claimingTask !== null}
                      className="rounded border border-sky-600 bg-sky-500/10 px-3 py-1 text-xs text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
                    >
                      {claimingTask === t.code ? '领取中…' : '领取'}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-600">未完成</span>
                  )}
                </div>
              ))}
              {tasks === null && (
                <p className="py-6 text-center text-xs text-slate-500">加载中…</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 待领取成就进入大厅弹出（触发时点文档未定义、按此口径注释标注；一键领取，可关闭手动前往成就页） */}
      {unclaimedAchievements.length > 0 && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-amber-700/60 bg-slate-900 p-5">
            <h3 className="mb-3 text-base font-bold text-amber-300">成就达成！</h3>
            <div className="mb-4 flex flex-col gap-2">
              {unclaimedAchievements.map((a) => (
                <div
                  key={a.code}
                  className="flex items-center justify-between rounded-lg border border-slate-700/70 bg-slate-950/60 px-3 py-2"
                >
                  <span className="text-sm text-slate-100">{a.name}</span>
                  <span className="text-xs text-amber-300">¥{formatMoney(a.rewardFen)}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void onClaimAllAchievements()}
                disabled={claimingAchievement}
                className="flex-1 rounded-lg bg-amber-500 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {claimingAchievement ? '领取中…' : '一键领取'}
              </button>
              <button
                onClick={() => setUnclaimedAchievements([])}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500"
              >
                稍后领取
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 风险提示弹窗 · 触发点 1（3.11）：进入非取款机档位；确认才开局，取消留在原页不调 start */}
      {pendingTier && (
        <RiskPopup
          message={RISK_TEXT_ENTRY}
          cancelText="取消"
          onConfirm={() => {
            const tier = pendingTier;
            setPendingTier(null);
            void doStart(tier);
          }}
          onCancel={() => setPendingTier(null)}
        />
      )}

      {/* 风险提示弹窗 · 触发点 2（3.11 / 3.8.4）：第 2/3 次破产救助提醒，仅确认按钮 */}
      {showBailoutReminder && (
        <RiskPopup
          title="温馨提示"
          message={RISK_TEXT_BAILOUT}
          onConfirm={() => setShowBailoutReminder(false)}
        />
      )}
    </Layout>
  );
}
