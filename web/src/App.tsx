export default function App() {
  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <h1 className="text-5xl font-bold tracking-widest text-amber-400">卡牌一掷千金</h1>
        <p className="max-w-xl leading-relaxed text-slate-300">
          经典 Deal or No Deal 玩法改编的本地自托管网页游戏。当前为脚手架占位首页，
          账号、对局、经济系统等功能将按开发计划陆续上线。
        </p>
        <p className="text-sm text-slate-500">
          后端探针：
          <code className="rounded bg-slate-800 px-2 py-0.5 text-amber-300">/api/health</code>
          （开发环境由 Vite 代理转发至 localhost:8080）
        </p>
      </main>
      {/* 铁律 10：页脚固定声明，任何页面不得移除 */}
      <footer className="border-t border-slate-800 py-4 text-center text-xs text-slate-500">
        本游戏为纯虚拟娱乐，无任何充值与变现功能，游戏资金无现实价值
      </footer>
    </div>
  );
}
