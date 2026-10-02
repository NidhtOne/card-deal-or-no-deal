import { NavLink } from 'react-router-dom';

const LINKS = [
  { to: '/lobby', label: '游戏大厅' },
  // 成就页（文档第四章路由清单；M4 新增入口）
  { to: '/achievements', label: '成就' },
  { to: '/profile', label: '个人中心' },
  { to: '/profile/character', label: '我的角色' },
  { to: '/settings', label: '设置' },
];

/** 受保护页面顶部导航（文档第四章路由） */
export default function PageHeader() {
  return (
    <header className="border-b border-slate-800 bg-slate-900/60">
      <nav className="mx-auto flex max-w-5xl items-center gap-1 px-4">
        <span className="mr-4 py-3 text-sm font-bold tracking-widest text-amber-400">
          卡牌一掷千金
        </span>
        {LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              `rounded px-3 py-3 text-sm ${
                isActive ? 'text-amber-300' : 'text-slate-400 hover:text-slate-200'
              }`
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
