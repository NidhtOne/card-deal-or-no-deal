import { FormEvent, useCallback, useEffect, useState } from 'react';
import { getErrorMessage } from '../api/client';
import { Overview, Profile, uploadImage, userApi } from '../api/user';
import ImageCropUpload from '../components/ImageCropUpload';
import Layout from '../components/Layout';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/auth';
import { formatFen } from '../utils/image';

const USERNAME_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 3.2：用户名修改限 1 次/30 天

/** /profile —— 个人中心：资料编辑（用户名 30 天限制提示）、头像上传裁剪、账户信息展示（文档 3.2 / 第四章） */
export default function ProfilePage() {
  const setAuthUser = useAuthStore((s) => s.setAuth);
  const auth = useAuthStore();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [signature, setSignature] = useState('');
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const [p, o] = await Promise.all([userApi.getProfile(), userApi.getOverview()]);
    setProfile(p);
    setOverview(o);
    setUsername(p.username);
    setNickname(p.nickname ?? '');
    setSignature(p.signature ?? '');
  }, []);

  useEffect(() => {
    reload().catch(() => setError('加载失败，请稍后重试'));
  }, [reload]);

  /** 用户名 30 天限制提示（3.2）：首改直接允许；否则显示下次可修改时间 */
  function usernameHint(): string {
    if (!profile?.usernameChangedAt) return '用户名每 30 天仅可修改一次（首次修改不限）';
    const nextAt = new Date(profile.usernameChangedAt).getTime() + USERNAME_INTERVAL_MS;
    if (Date.now() >= nextAt) return '用户名每 30 天仅可修改一次（当前可修改）';
    return `下次可修改时间：${new Date(nextAt).toLocaleString('zh-CN')}`;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage('');
    setError('');
    setSaving(true);
    try {
      const payload: { username?: string; nickname: string; signature: string } = {
        nickname,
        signature,
      };
      if (username.trim() !== profile?.username) payload.username = username.trim();
      const updated = await userApi.updateProfile(payload);
      setProfile(updated);
      setUsername(updated.username);
      setMessage('资料已保存');
      // 用户名可能已变更：同步本地登录态中的用户名
      if (auth.accessToken && auth.refreshToken && auth.user) {
        setAuthUser(
          {
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken,
            user: { ...auth.user, username: updated.username },
          },
          localStorage.getItem('dond.auth') !== null,
        );
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const avatarUrl = profile?.avatarUrl ?? '/assets/placeholders/avatar-default.png';

  return (
    <Layout>
      <PageHeader />
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold text-amber-300">个人中心</h1>

        {/* 头像 */}
        <section className="mb-6 flex items-center gap-6 rounded-xl border border-slate-800 bg-slate-900 p-6">
          <img
            src={avatarUrl}
            alt="头像"
            className="h-24 w-24 rounded-full border border-slate-700 object-cover"
          />
          <div>
            <p className="mb-2 text-sm text-slate-400">头像（JPG/PNG/WebP，≤5MB，建议 1:1）</p>
            <button
              onClick={() => setAvatarOpen(true)}
              className="rounded border border-amber-500 px-4 py-2 text-sm text-amber-300 hover:bg-amber-500/10"
            >
              {profile?.avatarUrl ? '更换头像' : '上传头像'}
            </button>
          </div>
        </section>

        {/* 资料编辑 */}
        <section className="mb-6 rounded-xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="mb-4 text-lg font-semibold">基础信息</h2>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-slate-400" htmlFor="username">
                用户名
              </label>
              <input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-amber-400"
              />
              <p className="mt-1 text-xs text-slate-500">{usernameHint()}</p>
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-400" htmlFor="nickname">
                昵称
              </label>
              <input
                id="nickname"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={24}
                className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-amber-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-400" htmlFor="signature">
                个性签名
              </label>
              <textarea
                id="signature"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                maxLength={120}
                rows={2}
                className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-amber-400"
              />
            </div>
            {error && <p className="text-sm text-rose-400">{error}</p>}
            {message && <p className="text-sm text-emerald-400">{message}</p>}
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-amber-500 px-6 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
            >
              {saving ? '保存中…' : '保存资料'}
            </button>
          </form>
        </section>

        {/* 账户信息 + 数据概览（overview；统计三项与 /api/history/stats 同源，M5 阶段 7 起为真实值） */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="mb-4 text-lg font-semibold">账户信息</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <StatCard label="当前余额（元）" value={overview ? formatFen(overview.balance) : '—'} highlight />
            <StatCard label="今日签到" value={overview ? (overview.todaySignedIn ? '已签到' : '未签到') : '—'} />
            <StatCard label="连续签到" value={overview ? `${overview.signinStreakDays} 天` : '—'} />
            <StatCard label="今日破产救助" value={overview ? `${overview.todayBailoutUsed} 次` : '—'} />
            <StatCard label="累计对局" value={overview ? `${overview.totalMatches} 局` : '—'} />
            <StatCard
              label="总盈亏（元）"
              value={overview ? formatFen(overview.totalProfit) : '—'}
            />
            <StatCard
              label="胜率"
              value={overview ? `${Math.round(overview.winRate * 100)}%` : '—'}
            />
          </div>
        </section>
      </div>

      <ImageCropUpload
        open={avatarOpen}
        title="上传头像"
        aspect={1}
        hint="建议 1:1 正方形"
        onClose={() => setAvatarOpen(false)}
        onUpload={async (blob, onProgress) => {
          await uploadImage('/user/avatar', blob, onProgress);
          await reload();
        }}
      />
    </Layout>
  );
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${highlight ? 'text-amber-300' : ''}`}>{value}</p>
    </div>
  );
}
