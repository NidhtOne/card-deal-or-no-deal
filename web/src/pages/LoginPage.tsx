import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getErrorMessage, getLockedSeconds } from '../api/client';
import Layout from '../components/Layout';
import { TokenBundle, useAuthStore } from '../store/auth';

/** /login —— 登录页（文档第四章） */
export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await api.post<TokenBundle>('/auth/login', {
        username: username.trim(),
        password,
        rememberMe,
      });
      setAuth(data, rememberMe);
      navigate('/lobby', { replace: true });
    } catch (err) {
      const lockedSeconds = getLockedSeconds(err);
      if (lockedSeconds !== null) {
        const minutes = Math.ceil(lockedSeconds / 60);
        setError(`账号已锁定，请约 ${minutes} 分钟后再试（剩余 ${lockedSeconds} 秒）`);
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Layout>
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <h1 className="mb-8 text-4xl font-bold tracking-widest text-amber-400">卡牌一掷千金</h1>
        <form
          onSubmit={onSubmit}
          className="w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-8"
        >
          <h2 className="text-xl font-semibold">登录</h2>
          <div>
            <label className="mb-1 block text-sm text-slate-400" htmlFor="username">
              用户名
            </label>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 outline-none focus:border-amber-400"
              autoComplete="username"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400" htmlFor="password">
              密码
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 outline-none focus:border-amber-400"
              autoComplete="current-password"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="accent-amber-400"
            />
            记住我（30 天内免登录）
          </label>
          {error && <p className="text-sm text-rose-400">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded bg-amber-500 py-2 font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {submitting ? '登录中…' : '登录'}
          </button>
          <div className="flex justify-between text-sm text-slate-400">
            <Link to="/register" className="hover:text-amber-300">
              注册新账号
            </Link>
            <Link to="/forgot-password" className="hover:text-amber-300">
              忘记密码
            </Link>
          </div>
        </form>
      </div>
    </Layout>
  );
}
