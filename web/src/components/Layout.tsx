import { ReactNode } from 'react';

/** 全局布局：含铁律 10 页脚固定声明，任何页面不得移除 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <main className="flex flex-1 flex-col">{children}</main>
      {/* 铁律 10：页脚固定声明 */}
      <footer className="border-t border-slate-800 py-4 text-center text-xs text-slate-500">
        本游戏为纯虚拟娱乐，无任何充值与变现功能，游戏资金无现实价值
      </footer>
    </div>
  );
}
