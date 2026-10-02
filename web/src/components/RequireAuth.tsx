import { Navigate, Outlet } from 'react-router-dom';
import AudioController from '../audio/AudioController';
import { useAuthStore } from '../store/auth';

/** 路由守卫：未登录访问受保护页面跳 /login（文档第四章）；登录态下挂音频控制器（3.9，阶段 6） */
export default function RequireAuth() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  if (!accessToken && !refreshToken) {
    return <Navigate to="/login" replace />;
  }
  return (
    <>
      {/* 音频生效闭环挂载点：登录后拉设置起播、随路由切氛围曲；登出卸载停曲（3.9） */}
      <AudioController />
      <Outlet />
    </>
  );
}
