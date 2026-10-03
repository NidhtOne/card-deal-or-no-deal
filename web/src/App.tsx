import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import AchievementsPage from './pages/AchievementsPage';
import CharacterPage from './pages/CharacterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import HistoryPage from './pages/HistoryPage';
import LobbyPage from './pages/LobbyPage';
import LoginPage from './pages/LoginPage';
import MatchLoadPage from './pages/MatchLoadPage';
import MatchPlayPage from './pages/MatchPlayPage';
import MatchResultPage from './pages/MatchResultPage';
import ProfilePage from './pages/ProfilePage';
import RegisterPage from './pages/RegisterPage';
import SettingsPage from './pages/SettingsPage';

/**
 * 路由（文档第四章，逐字）。已实现：/login、/register、/forgot-password、/lobby、
 * /match/load/:sessionId、/match/play/:sessionId、/match/result/:sessionId、
 * /history（M5 阶段 7：列表 + 筛选 + 统计面板）、/profile、/profile/character、
 * /settings、/achievements（M4）。全部需登录页面均有路由守卫。
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
          <Route path="/match/load/:sessionId" element={<MatchLoadPage />} />
          <Route path="/match/play/:sessionId" element={<MatchPlayPage />} />
          <Route path="/match/result/:sessionId" element={<MatchResultPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/achievements" element={<AchievementsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/profile/character" element={<CharacterPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/" element={<Navigate to="/lobby" replace />} />
        <Route path="*" element={<Navigate to="/lobby" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
