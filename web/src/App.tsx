import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import LobbyPage from './pages/LobbyPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';

/**
 * 路由（文档第四章）。本阶段实现：/login、/register、/forgot-password、/lobby（占位）。
 * 其余路由（/match/*、/history、/achievements、/profile、/settings）后续阶段补齐。
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        {/* 受保护路由：未登录跳 /login */}
        <Route element={<RequireAuth />}>
          <Route path="/lobby" element={<LobbyPage />} />
        </Route>
        <Route path="/" element={<Navigate to="/lobby" replace />} />
        <Route path="*" element={<Navigate to="/lobby" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
