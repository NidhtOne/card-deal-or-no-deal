import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getErrorMessage } from '../api/client';
import Layout from '../components/Layout';

const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,20}$/;

/** /forgot-password —— 找回密码页（文档第四章，3.1.1 方式①：密保问题重置） */
export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [question, setQuestion] = useState<string | null>(null);
  const [securityAnswer, setSecurityAnswer] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function fetchQuestion(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!username.trim()) {
      setError('请输入用户名');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await api.get<{ question: string }>('/auth/security-question', {
        params: { username: username.trim() },
      });
      setQuestion(data.question);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onReset(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!securityAnswer.trim()) {
      setError('请输入密保答案');
      return;
    }
    if (!PASSWORD_RE.test(newPassword)) {
      setError('新密码需为 8-20 位且同时包含字母和数字');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/auth/forgot-password', {
        username: username.trim(),
        securityAnswer: securityAnswer.trim(),
        newPassword,
      });
      alert('密码已重置，请使用新密码登录');
      navigate('/login', { replace: true });
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
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-8">
          <h2 className="text-xl font-semibold">找回密码</h2>
          {question === null ? (
            <form onSubmit={fetchQuestion} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm text-slate-400" htmlFor="username">
                  用户名
                </label>
                <input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={inputCls}
                  autoComplete="username"
                />
              </div>
              {error && <p className="text-sm text-rose-400">{error}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded bg-amber-500 py-2 font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {submitting ? '查询中…' : '下一步'}
              </button>
            </form>
          ) : (
            <form onSubmit={onReset} className="space-y-4">
              <div className="rounded bg-slate-800 px-3 py-2 text-sm">
                <span className="text-slate-400">密保问题：</span>
                {question}
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
              <div>
                <label className="mb-1 block text-sm text-slate-400" htmlFor="newPassword">
                  新密码（8-20 位，含字母和数字）
                </label>
                <input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className={inputCls}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-400" htmlFor="confirmPassword">
                  确认新密码
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
              {error && <p className="text-sm text-rose-400">{error}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded bg-amber-500 py-2 font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {submitting ? '提交中…' : '重置密码'}
              </button>
            </form>
          )}
          <p className="text-center text-sm text-slate-400">
            <Link to="/login" className="hover:text-amber-300">
              返回登录
            </Link>
          </p>
        </div>
      </div>
    </Layout>
  );
}
