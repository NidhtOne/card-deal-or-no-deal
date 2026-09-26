import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getErrorMessage } from '../api/client';
import Layout from '../components/Layout';
import { TokenBundle, useAuthStore } from '../store/auth';

const USERNAME_RE = /^[A-Za-z0-9_]{4,16}$/;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,20}$/;

/** /register —— 注册页（文档第四章），注册成功自动登录进入大厅（3.1.1） */
export default function RegisterPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [securityQuestion, setSecurityQuestion] = useState('');
  const [securityAnswer, setSecurityAnswer] = useState('');
  const [usernameHint, setUsernameHint] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 用户名唯一性实时校验（3.1.1），防抖 300ms
  useEffect(() => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    if (!USERNAME_RE.test(username)) {
      setUsernameHint(
        username ? { ok: false, text: '用户名需为 4-16 位字母、数字或下划线' } : null,
      );
      return;
    }
    checkTimer.current = setTimeout(async () => {
      try {
        const { data } = await api.get<{ available: boolean }>('/auth/check-username', {
          params: { username },
        });
        setUsernameHint(
          data.available ? { ok: true, text: '用户名可用' } : { ok: false, text: '用户名已被占用' },
        );
      } catch {
        setUsernameHint(null);
      }
    }, 300);
    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    };
  }, [username]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!USERNAME_RE.test(username)) {
      setError('用户名需为 4-16 位字母、数字或下划线');
      return;
    }
    if (!PASSWORD_RE.test(password)) {
      setError('密码需为 8-20 位且同时包含字母和数字');
      return;
    }
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    if (!securityQuestion.trim() || !securityAnswer.trim()) {
      setError('请填写密保问题与答案（用于找回密码）');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await api.post<TokenBundle>('/auth/register', {
        username: username.trim(),
        password,
        confirmPassword,
        securityQuestion: securityQuestion.trim(),
        securityAnswer: securityAnswer.trim(),
      });
      // 注册成功自动登录进入大厅（3.1.1）
      setAuth(data, false);
      navigate('/lobby', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    'w-full rounded border border-slate-700 bg-slate-800 px-3 py-2 outline-none focus:border-amber-400';

  return (
    <Layout>
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        <form
          onSubmit={onSubmit}
          className="w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-8"
        >
          <h2 className="text-xl font-semibold">注册</h2>
          <div>
            <label className="mb-1 block text-sm text-slate-400" htmlFor="username">
              用户名（4-16 位字母、数字或下划线）
            </label>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={inputCls}
              autoComplete="username"
            />
            {usernameHint && (
              <p className={`mt-1 text-xs ${usernameHint.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                {usernameHint.text}
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400" htmlFor="password">
              密码（8-20 位，含字母和数字）
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400" htmlFor="confirmPassword">
              确认密码
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={inputCls}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400" htmlFor="securityQuestion">
              密保问题（用于找回密码）
            </label>
            <input
              id="securityQuestion"
              value={securityQuestion}
              onChange={(e) => setSecurityQuestion(e.target.value)}
              className={inputCls}
              placeholder="例如：我的小学名称？"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400" htmlFor="securityAnswer">
              密保答案
            </label>
            <input
              id="securityAnswer"
              value={securityAnswer}
              onChange={(e) => setSecurityAnswer(e.target.value)}
              className={inputCls}
            />
          </div>
          {error && <p className="text-sm text-rose-400">{error}</p>}
          <button
            type="submit"
            disabled={submitting || usernameHint?.ok === false}
            className="w-full rounded bg-amber-500 py-2 font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {submitting ? '注册中…' : '注册并进入大厅'}
          </button>
          <p className="text-center text-sm text-slate-400">
            已有账号？
            <Link to="/login" className="hover:text-amber-300">
              去登录
            </Link>
          </p>
        </form>
      </div>
    </Layout>
  );
}
