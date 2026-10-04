# 卡牌一掷千金（Deal or No Deal Cards）

## 项目简介

《卡牌一掷千金》是经典 Deal or No Deal 玩法改编的本地自托管网页游戏，采用 Node 20、NestJS、React、SQLite 与 npm workspaces 构建。

> **本游戏为纯虚拟娱乐，无任何充值与变现功能，游戏资金无现实价值。**

## 功能列表

### 账号与设置

- 注册、登录、令牌刷新、找回密码与个人中心
- 头像、角色图和银行家角色管理
- 音乐、音效、风险提示、面额清单和历史保留期设置

### 对局

- 五档位场次与每局 26 张卡牌
- 服务端权威生成卡池、银行家报价和还价判定
- 成交、拒绝、终局二选一、超时托管和掉线重连
- 对局状态持久化，服务重启后可恢复

### 经济系统

- 每日签到、每日任务、破产救助与成就
- 整数“分”记账、资金流水和阶梯计税
- 连胜盈利冻结为可选风控开关，默认关闭
- `config/economy.json` 中 `win_streak_guard` 的数值由部署者自行填写；默认均为 `null`
- 启用连胜盈利冻结前，`trigger_profit_fen`、`keep_ratio_bp`、`cap_fen`、`reset_hours` 四项必须全部配置为正整数，否则服务拒绝启动

### 历史与统计

- 对局历史、筛选与统计面板
- 用户可配置历史保留期
- 到期历史自动清理

### 音频系统

- 大厅、加载、对局和结算氛围音乐
- 翻牌、报价、成交、拒绝、揭晓与结算音效
- 支持替换或扩展本地音乐资源

## 部署指南

### 前置要求

| 部署方式 | 依赖                                          |
| -------- | --------------------------------------------- |
| Docker   | Docker Engine 20+（含 `docker compose` 插件） |
| 裸机     | Node.js ≥ 20（`node -v` 确认），npm 10+       |

获取代码并进入目录：

```bash
git clone https://github.com/NidhtOne/card-deal-or-no-deal.git
cd card-deal-or-no-deal
```

### 方式一：Docker 部署（推荐）

```bash
docker compose up -d --build
```

1. 首次启动会自动安装依赖、构建前后端，并执行数据库迁移；
2. 启动完成后访问 <http://localhost:8080>；
3. 注册任意账号即可开始游戏，新账号自动获得初始虚拟资金。

数据持久化：宿主机 `./data`（SQLite 数据库）、`./storage`（用户上传文件）、`./config`（游戏数值配置，只读挂载）。删除容器不丢数据，除非删除这三个目录。

生产环境建议在环境或 `.env` 中显式设置稳定的 `JWT_SECRET`，这样会跳过 `.env` 初始化和写盘，并避免容器重建后重新生成密钥导致既有登录态失效。也可以为容器挂载持久化 `.env` 文件。

常用运维命令：

```bash
docker compose logs -f          # 跟踪日志
docker compose restart          # 重启服务
docker compose down             # 停止并移除容器（数据保留）
docker compose up -d --build    # 改代码或改配置后重建升级
```

### 方式二：裸机部署

需要 Node.js 20：

```bash
npm install          # 安装依赖（npm workspaces：server + web）
npm run build        # 构建服务端 dist 与前端产物
npm start            # 生产启动
```

行为说明：

- 生产入口会在缺少 `.env` 或 `JWT_SECRET` 为空时自动初始化本地 `.env`（生成随机密钥），然后启动服务；
- 首次启动自动创建 `data/`、`storage/` 目录并执行数据库迁移，无需手工建库；
- 生产环境建议先复制 `.env.example` 为 `.env` 并固定 `JWT_SECRET`，避免重启后登录态失效；也可用 systemd 等进程管理器将 `npm start` 托管为服务。

### 开发模式

```bash
npm run dev
```

同时启动后端（NestJS watch）与前端（Vite，<http://localhost:5173>，已代理 `/api`、`/assets`、`/uploads`、`/ws` 到后端端口）。首次运行会自动初始化 `.env`。

### 升级与验证

```bash
# Docker
git pull && docker compose up -d --build

# 裸机
git pull && npm install && npm run build && npm start
```

升级只替换代码，`data/` 与 `storage/` 中的用户数据保持不变；数据库迁移在启动时自动执行。

健康检查（Docker 镜像内置同款探针）：

```bash
curl http://localhost:8080/api/health
```

忘记密码时可在服务器上执行（数据库路径读取 `.env` 的 `DATABASE_URL`）：

```bash
node scripts/reset-password.js <用户名> <新密码>
```

## 配置说明

### 环境变量

| 变量           | 默认值           | 说明                             |
| -------------- | ---------------- | -------------------------------- |
| `PORT`         | `8080`           | 服务监听端口                     |
| `JWT_SECRET`   | 空               | JWT 密钥；空值时首次启动自动生成 |
| `DATABASE_URL` | `./data/game.db` | SQLite 数据库路径                |
| `STORAGE_DIR`  | `./storage`      | 用户上传文件目录                 |
| `USE_REDIS`    | `false`          | 是否启用 Redis                   |

完整样例见 `.env.example`。真实密钥只能保存在 `.env` 或部署环境变量中，不得提交到仓库。

游戏数值集中在 `config/tiers.json` 和 `config/economy.json`。修改 JSON 后重启服务即可生效。

连胜盈利冻结配置位于 `config/economy.json` 的 `win_streak_guard` 段。该功能默认关闭，金额单位、比例和时长口径请以该段 `_comment` 为准。

## 玩法规则

完整公开规则见 docs/卡牌一掷千金完整官方游戏规则.md。

核心流程为选择档位、选定底牌、按轮次翻牌、处理银行家报价与还价，并在最终两张牌阶段选择保留或交换底牌后结算。卡池、报价、税费和结算结果均由服务端权威生成。

系统架构、模块划分、数据库与 API 设计详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 素材与授权

`assets/bankers`、`assets/music` 和 `assets/placeholders` 中的现有素材全部由 `scripts/generate-placeholders.js` 程序生成，为项目自制占位素材，不包含第三方版权内容。

内置音乐为占位音。替换及扩展方式见 `assets/music/README.md`。

## 开源协议

本项目基于 [MIT](LICENSE) 协议开源。
