# 卡牌一掷千金（Deal or No Deal Cards）

经典 Deal or No Deal 玩法改编的网页游戏，本地自托管单体应用（Node 20 + npm workspaces）。

> **声明**：本游戏为纯虚拟娱乐，无任何充值与变现功能，游戏资金无现实价值。

## 技术栈

- 后端 `server/`：NestJS 10 + TypeORM + better-sqlite3（WAL）+ socket.io
- 前端 `web/`：React 18 + TypeScript + Vite + Tailwind CSS
- 数据库：SQLite（默认 `./data/game.db`，WAL 模式），表结构变更走 TypeORM migration

## 目录结构

```
├── config/               # 游戏数值配置（tiers.json / economy.json，改 JSON 即生效）
├── assets/               # 内置素材：bankers/ 立绘、music/ BGM、placeholders/ 占位图（托管为 /assets/...）
├── scripts/              # 本地脚本（init-env.js 初始化 .env 与 JWT_SECRET）
├── docs/                 # 开发文档.md（功能/数据库/API/路由/部署的权威依据）
├── server/               # 后端（NestJS）
│   └── src/
│       ├── config/       # 路径与环境变量解析
│       ├── database/     # TypeORM DataSource 与 migrations
│       ├── health/       # GET /api/health
│       └── events/       # socket.io 网关（/ws/socket.io，事件后续阶段实现）
├── web/                  # 前端（React + Vite）
├── data/                 # 运行期生成：SQLite 数据库（不入库）
└── storage/              # 运行期生成：用户上传文件（不入库）
```

## 快速开始

```bash
npm install
npm run dev        # 自动初始化 .env 与 JWT_SECRET，前后端并行启动
```

- 前端（开发热更新）：http://localhost:5173
- 后端 API：http://localhost:8080/api/health
- 静态资源：http://localhost:8080/assets/
- WebSocket（socket.io）：`/ws/socket.io`

生产模式：`npm run build && npm start`，由后端在 8080 端口直接托管 `web/dist` 与 `assets/`。

## 常用脚本

| 命令              | 说明                                       |
| ----------------- | ------------------------------------------ |
| `npm run dev`     | 前后端并行开发（含 .env 自动初始化）       |
| `npm run build`   | 构建 server 与 web                         |
| `npm run start`   | 生产模式启动后端（托管前端构建产物）       |
| `npm run lint`    | ESLint 检查                                |
| `npm run format`  | Prettier 格式化                            |
| `npm run test`    | 运行全部 workspace 测试                    |

server 目录内另有 `migration:generate / migration:run / migration:revert / migration:show`（TypeORM CLI）。

## 配置

见 `.env.example`（PORT / JWT_SECRET / DATABASE_URL / STORAGE_DIR / USE_REDIS）。
`.env` 不存在或 `JWT_SECRET` 为空时，`npm run dev` 会自动生成随机密钥写入本地 `.env`（不入库）。

## TODO（后续阶段补全）

- [ ] 账号系统、个人中心、设置（M1）
- [ ] 对局核心状态机与结算（M2，含 config/tiers.json 数值填充）
- [ ] 角色、对局页布局与动效、背景音乐（M3）
- [ ] 签到、任务、破产保护、成就（M4，含 config/economy.json 数值填充）
- [ ] Dockerfile / docker-compose、重置密码脚本（M5）
- [ ] 截图、CI、LICENSE、素材授权核查（M6）
