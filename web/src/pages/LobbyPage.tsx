import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import Layout from '../components/Layout';
import { AuthUser, useAuthStore } from '../store/auth';

/**
 * /lobby —— 游戏大厅（最小占位页，登录后落地页）。
 * 显示当前用户名；完整的资金/签到/任务/档位选择在后续阶段实现（文档第四章）。
 */
export default function LobbyPage() {
  const navigate = useNavigate();
  const { user, refreshToken, clear } = useAuthStore();
  const [sessionUser, setSessionUser] = useState<AuthUser | null>(user ?? null);

  // 通过受保护接口验证会话（Access 过期时由拦截器自动 Refresh）
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ user: AuthUser }>('/auth/session')
      .then(({ data }) => {
        if (!cancelled) setSessionUser(data.user);
      })
      .catch(() => {
        /* Refresh 失败时拦截器已负责跳转登录页 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onLogout() {
    try {
      if (refreshToken) await api.post('/auth/logout', { refreshToken });
    } catch {
      /* 登出幂等，失败也继续清理本地状态 */
    }
    clear();
    navigate('/login', { replace: true });
  }

  return (
    <Layout>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <h1 className="text-4xl font-bold tracking-widest text-amber-400">游戏大厅</h1>
        <p className="text-lg text-slate-300">
          欢迎回来，<span className="font-semibold text-amber-300">{sessionUser?.username}</span>
        </p>
        <p className="max-w-xl text-sm leading-relaxed text-slate-500">
          大厅功能建设中：资金余额、签到、每日任务、五档场次选择与破产保护将在后续阶段上线。
        </p>
        <button
          onClick={onLogout}
          className="rounded border border-slate-700 px-6 py-2 text-sm text-slate-300 hover:border-rose-400 hover:text-rose-300"
        >
          退出登录
        </button>
      </div>
    </Layout>
  );
}
