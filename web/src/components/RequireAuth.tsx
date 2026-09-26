import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../store/auth';

/** 路由守卫：未登录访问受保护页面跳 /login（文档第四章） */
export default function RequireAuth() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  if (!accessToken && !refreshToken) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
