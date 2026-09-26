# 提示词存档：阶段一成果 Git 提交

> 用途：让 Codex 将「端口参数化 + 账号系统」阶段成果提交入库。已按当前仓库实际状态核验（git status / check-ignore / diff），可直接下发。

任务：将当前工作区的阶段成果提交 Git，严格按以下步骤与约束执行。

## 提交前安全检查（铁律 5，必做）
1. `git status --porcelain` 确认待提交文件清单；
2. 确认以下文件/目录**绝不进入暂存区**（.gitignore 已兜底，但必须显式复核）：
   `.env`、`data/test-integration.db`、`node_modules/`、`server/dist/`、
   `web/dist/`、`data/`、`storage/`（两者仅 .gitkeep 已跟踪，勿动）。
3. 提交前复跑 `npm run lint && npm run test`，全绿方可提交（铁律 9）。

## 提交方案：2 个 commit（Conventional Commits + 中文描述，沿用首个 commit 风格）

### Commit 1 —— chore（工程配置）
文件：`web/vite.config.ts`
```
chore: vite 端口参数化与构建目录避让

- dev 代理（/api、/assets、/ws）目标改为读取仓库根 .env 的 PORT（缺省 8080），
  消除硬编码 8080
- build.assetsDir 改为 static，避免与后端托管的 /assets 目录冲突；
  emptyOutDir=false（Windows 非 ASCII 路径下 fs.rmSync 崩溃，由 scripts/clean.js 预清理）
```

### Commit 2 —— feat（账号系统主体）
文件：除 Commit 1 外的全部改动，包括：
- `README.md`（端口冲突排查 + 账号系统说明）
- `config/economy.json`
- `package-lock.json`、`server/package.json`、`web/package.json`
- `server/src/`（app.module.ts、main.ts、database/、auth/、common/、config/、entities/、user/、wallet/）
- `server/test/`
- `web/src/`（App.tsx、api/、components/、pages/、store/）
- `scripts/reset-password.js`
```
feat: 实现账号系统（注册/登录/双令牌/密保找回/改密/注销）

- 后端：users/user_profiles/user_wallets/user_settings/fund_flows/refresh_tokens
  六表 migration（金额一律 INTEGER 单位分，铁律 4）；注册单事务建四表 +
  初始赠送流水（idem_key=register:{userId}）；登录连续失败 5 次锁定 15 分钟
  （423+剩余秒数）；JWT Access 2h + Refresh 14d（记住我 30d），轮换即吊销、
  重放 401；密保重置/改密后全量吊销令牌；注销级联删除
- 前端：/login、/register、/forgot-password、/lobby 页面；zustand 认证状态
  （记住我→localStorage）；路由守卫；Axios 401 单飞行自动 Refresh
- README：端口冲突排查一节、账号系统使用说明
- 集成测试 17 例全绿
```

## 禁止事项
- 禁止 `git add -A` / `git add .` 无脑全量暂存（按上述清单显式 add）；
- 禁止 push（本阶段无远程操作）；
- 禁止 amend/修改已有的初始 commit；
- 禁止 `--no-verify` 跳过钩子；
- 禁止修改 git 配置（含 core.autocrlf；LF/CRLF 警告忽略即可，不要处理）。

## 验收
- `git log --oneline` 显示 2 条新 commit，信息符合上述格式；
- `git status` 干净（仅剩余 .gitignore 覆盖的忽略项）；
- `git ls-files | grep -E "^\.env$|\.db$"` 输出为空（密钥与数据库未入库）；
- 提交完成后输出两个 commit 的 hash 与 `git show --stat` 摘要。
