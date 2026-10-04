# 架构设计文档

> 本文档面向贡献者与自托管部署者，描述《卡牌一掷千金》**已实现**的系统架构、模块划分、数据库与 API 设计。
> 玩法规则完整定义见 [docs/卡牌一掷千金完整官方游戏规则.md](docs/卡牌一掷千金完整官方游戏规则.md)。
> 标注「文档外补充」的条目为规则文档未定义、由实现补齐的内容；本文与代码不一致时，以代码为准。
>
> **本游戏为纯虚拟娱乐，无任何充值与变现功能，游戏资金无现实价值。**

---

## 1. 总体架构

本地自托管单体应用：前端静态资源由后端服务直接托管，数据库与上传文件全部落本地磁盘，不依赖任何云服务。

```
┌────────────────────────────────────────────────────────────┐
│              本地机器（Docker 或裸机，端口 8080）              │
│                                                            │
│  ┌──────────────┐  REST /api   ┌────────────────────────┐  │
│  │  Web 前端     │ ◄──────────► │  后端服务 (NestJS)       │  │
│  │  React SPA    │  WS /ws      │  业务逻辑 + 静态托管      │  │
│  │  (web/dist)   │              │  game-engine 纯逻辑     │  │
│  └──────────────┘              └───────────┬────────────┘  │
│                                            │               │
│              ┌──────────────┬──────────────┼────────────┐  │
│              ▼              ▼              ▼            ▼  │
│        ┌──────────┐  ┌───────────┐  ┌────────────┐ ┌─────┐ │
│        │ SQLite   │  │ storage/  │  │ assets/    │ │ ... │ │
│        │ WAL 模式 │  │ 用户上传   │  │ 内置素材    │ │     │ │
│        │ data.db  │  │ 头像/立绘  │  │ 立绘/BGM   │ │     │ │
│        └──────────┘  └───────────┘  └────────────┘ └─────┘ │
└────────────────────────────────────────────────────────────┘
```

- 路由分工：`/api/*` REST 接口；`/ws/socket.io` WebSocket；`/assets/*` 内置素材；`/uploads/*` 用户上传文件；其余路径回退到 SPA（生产模式下托管 `web/dist`）。

## 2. 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Node.js 20，npm workspaces（`server/` + `web/` 单仓双包） |
| 后端 | NestJS 10 + TypeORM + better-sqlite3（WAL 模式） |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS + zustand |
| 实时通信 | socket.io（对局事件推送）+ REST 轮询兜底 |
| 音频 | Howler.js（BGM / SFX 统一管理） |
| 认证 | JWT（Access 2 小时 + Refresh 14 天，Refresh 哈希落库可吊销），bcrypt 密码散列 |
| 测试 | Jest（server 单测 + 集成 e2e、web 单测）+ Playwright（浏览器 e2e） |
| 部署 | Dockerfile + docker-compose.yml；裸机 `npm run build && npm start` |

## 3. 核心设计原则

1. **服务端权威**：卡池生成、底牌归属、银行家报价、还价判定、计税结算全部由服务端完成并落库，前端只展示与提交操作。
2. **资金安全**：一切资金变动在数据库事务内完成，同步写入 `fund_flows` 流水；余额 UPDATE 带条件防负余额；唯一约束 + 幂等键防重复发放。
3. **金额一律整数「分」**：所有金额字段为 INTEGER（卡牌面额含 0.01 元）；配置文件以「元」书写便于阅读，加载时统一 `Math.round(元 × 100)` 转分，启动期对非法配置 fail fast。
4. **全局事务互斥**：better-sqlite3 的 TypeORM QueryRunner 为全局单例，并发事务会退化为 SAVEPOINT 嵌套。所有写事务走 `runInTransaction`（`server/src/common/transaction.ts`）的全局 FIFO 互斥锁，保证事务语义正确；用户名修改另加按用户串行锁 `withUsernameLock`。
5. **配置外置**：所有游戏数值集中在 `config/tiers.json` 与 `config/economy.json`，改 JSON 重启即生效，代码禁止硬编码数值。
6. **零硬编码密钥**：密钥/路径只从 `.env` / 环境变量读取；`JWT_SECRET` 为空时由启动脚本自动生成随机值写回本地 `.env`，仓库只提供 `.env.example`。
7. **引擎纯逻辑**：`game-engine` 为纯 TypeScript 模块，禁止 import NestJS 与任何 I/O，随机性通过注入 RNG 接口实现，便于确定性单元测试。

## 4. 仓库目录结构

```
├── ARCHITECTURE.md          # 本文档
├── README.md / LICENSE / CONTRIBUTING.md / CHANGELOG.md
├── .env.example             # 环境变量样例（密钥留空）
├── Dockerfile / docker-compose.yml / .dockerignore
├── .github/workflows/ci.yml # CI：lint + test + build
├── config/
│   ├── tiers.json           # 五档金额模板、翻牌轮次、报价系数
│   └── economy.json         # 初始资金、税率、签到、任务、救助、成就
├── assets/                  # bankers/ 立绘、music/ BGM+SFX、placeholders/ 占位图
├── scripts/                 # init-env / start-prod / reset-password / generate-placeholders / clean
├── docs/
│   └── 卡牌一掷千金完整官方游戏规则.md
├── server/                  # NestJS 后端
│   └── src/（见下文模块划分）
├── web/                     # React 前端
│   ├── src/ e2e/ playwright.config.ts
├── data/                    # 运行期生成：SQLite 数据库（不入库）
└── storage/                 # 运行期生成：用户上传文件（不入库）
```

## 5. 后端模块（server/src）

| 模块 | 职责 |
| --- | --- |
| `auth/` | 注册（用户名唯一实时校验、密保问题）、登录（连续失败 5 次锁定 15 分钟，HTTP 423）、令牌刷新/注销、密保找回密码、会话查询；JWT Guard |
| `user/` | 个人资料、头像上传、角色立绘（保留最近 3 张历史可切换）、银行家角色选择/上传、设置读写、数据概览、修改密码、账号注销；改名按用户串行锁 |
| `wallet/` | 余额与资金流水查询 |
| `economy/` | 每日签到（幂等）、每日任务与领奖、破产救助、成就判定与领取；成就统一在结算事件判定 |
| `match/` | 对局全流程：档位查询、开局扣费生成卡池、选底牌、翻牌、报价、成交/还价/拒绝、终局换牌、状态恢复、面额清单；含 WebSocket 网关、超时托管时钟、连胜盈利冻结（可选） |
| `history/` | 对决历史列表（分页/筛选）与统计面板；强制 user_id 过滤；按保留期自动清理 |
| `upload/` | 上传文件落盘（`storage/`，服务端重编码去 EXIF）与资产目录 |
| `events/` | WebSocket 基础网关（连接/断连） |
| `health/` | 健康检查 |
| `common/` | `runInTransaction` 全局事务互斥、`withUsernameLock`、本地日期、数据库错误映射 |
| `database/` | 数据源装配 + 迁移 |
| `config/` | tiers/economy 配置加载与校验（非法即启动失败）、路径解析 |
| `game-engine/` | 纯逻辑游戏引擎（见下节） |

## 6. 游戏引擎（server/src/game-engine）

| 文件 | 职责 |
| --- | --- |
| `rng.ts` | RNG 注入接口（默认 crypto 实现，测试可注入伪随机） |
| `pool.ts` | 卡池生成：按档位模板加权抽取 26 张唯一金额，小额锚点固定不扰动，非锚点在 ±jitter 内扰动 |
| `offer.ts` | 报价：Offer = min(EV × k(轮次), 档位上限)，k 按前/中/终局区间随机；还价概率判定（≤85% EV 必接受、介于 85%~100% 线性递减、>EV 必拒绝） |
| `tax.ts` | 阶梯计税纯函数 `calcTax(profit)`（见 §11） |
| `engine.ts` | 对局状态机（见 §7） |
| `config.ts` / `types.ts` | 引擎侧配置类型与校验 |

引擎不直接读写数据库，由 `match/game-session.service.ts` 负责状态落库与事务编排。

## 7. 对局流程状态机

```
大厅 → 选档位(扣入场费,事务) → 加载页 → PICK_OWN_CARD(选1张底牌)
                                              │
                                     FLIP_ROUND_N(按轮次翻牌)
                                              │
                                     BANKER_OFFER(报价)
                            ┌─────────────────┼────────────────┐
                         DEAL成交          COUNTER还价        NO_DEAL拒绝
                            │                 │                  │
                       SETTLE结算      接受→SETTLE        剩余>2→下一轮翻牌
                                          拒绝→回到报价      剩余=2→FINAL_OFFER
                                                                 │
                                              LAST_REFUSE→SWAP(换牌/保留 二选一)
                                                                 │
                                          REVEAL开牌 → TAX计税 → SETTLE结算 → 存档
```

- **轮次固定**：第 1–5 轮翻 6/5/4/3/2 张，第 6 轮起每轮 1 张，直至剩 2 张进终局。
- **还价**：每轮限 1 次；非法输入直接驳回且不消耗次数。
- **终局换牌**：仅剩 2 张时，保留底牌或与最后 1 张公共牌互换，二选一不可相加。
- **异常处理**：掉线/刷新按 sessionId 拉取全量状态恢复（`GET /api/match/:id/state`）；5 分钟无操作服务端自动判 No Deal 并托管走完流程结算；入场费不返还；不提供手动弃权。

## 8. 数据库设计

better-sqlite3 单文件库（WAL 模式），TypeORM 实体声明 + 启动期 synchronize 装配与迁移回填。通用约定：**金额字段一律 INTEGER「分」**；时间戳 TEXT/ datetime；用户子表外键级联删除。

### 8.1 表清单（17 张）

**账号与用户**

| 表 | 说明 |
| --- | --- |
| `users` | 账号：username 唯一、bcrypt 密码散列、密保问题/答案散列、状态、失败锁定字段 |
| `user_profiles` | 昵称、签名、头像 URL、当前角色立绘 URL、自定义银行家图、改名时间戳 |
| `user_settings` | BGM 开关/曲目/音量、SFX 开关/音量、面额清单、风险弹窗、成就开关、历史保留天数 |
| `user_character_images` | 角色立绘历史（保留最近 3 张）【文档外补充】 |
| `refresh_tokens` | Refresh Token 哈希（唯一）、过期与吊销时间 |
| `user_game_state` | 跨局累计状态：连胜计数、连胜段税后累计、冻结标志、累计结算局数【文档外补充】 |

**资金**

| 表 | 说明 |
| --- | --- |
| `user_wallets` | 余额（INTEGER 分），一切读写走事务 |
| `fund_flows` | 资金流水：type（初始赠送/入场/奖金/税/签到/任务/救助/成就）、变动后余额、关联 ref_id、幂等键（唯一） |

**对局**

| 表 | 说明 |
| --- | --- |
| `game_sessions` | 对局主表：档位、入场费/档位上限快照、状态机状态、底牌、轮次/配额、当前报价、超时截止、结算四件套（税前奖金/税/净盈亏/结算后余额）、状态快照、起止时间 |
| `game_cards` | 每局 26 张：position 0–25、金额（唯一）、状态（底牌/公共/已淘汰） |
| `offers` | 报价记录：轮次、金额、结果（成交/还价接受/还价拒绝/拒绝/超时）、还价金额、EV 与还价判定留痕 |

**经济**

| 表 | 说明 |
| --- | --- |
| `daily_signins` | 签到：唯一 (user_id, sign_date)、连签天数、奖励 |
| `daily_tasks` / `user_task_progress` | 任务定义与每日进度；进度表唯一 (user, task_code, date)，claimed 标记 |
| `bailout_records` | 破产救助：唯一 (user_id, apply_date, nth)，第 n 次申请一行【文档外补充】 |
| `achievements` / `user_achievements` | 成就定义与解锁记录：唯一 (user_id, achievement_id)、解锁时间、领取标记 |

### 8.2 关键约束与索引

- `game_cards(session_id, position)` 唯一索引；
- `game_sessions(user_id, status)` 索引（进行中对局恢复）、`game_sessions(user_id, finished_at)` 索引（历史查询）；
- `fund_flows.idem_key` 唯一 + 各经济发放唯一约束 → 幂等防重；
- 余额 UPDATE 一律带余额条件，防负余额。

## 9. API 设计

全局前缀 `/api`，JWT Bearer 认证（登录/注册/健康检查等公开接口除外）。领奖、扣费、结算类接口幂等。

### 9.1 账号 `/api/auth`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/register` | 注册（含密保问题） |
| GET | `/check-username` | 用户名唯一实时校验 |
| GET | `/security-question` | 查询密保问题 |
| POST | `/login` | 登录，返回 Access + Refresh |
| POST | `/refresh` | 刷新令牌 |
| POST | `/logout` | 注销（吊销 Refresh） |
| POST | `/forgot-password` | 密保校验 + 重置密码 |
| GET | `/session` | 当前会话信息 |

### 9.2 用户 `/api/user`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / PUT | `/profile` | 获取/更新资料 |
| POST | `/avatar` | 上传头像（multipart） |
| POST | `/character` | 上传角色立绘 |
| GET | `/character/history` | 立绘历史（最近 3 张） |
| POST | `/character/:id/activate` | 切换生效立绘 |
| GET | `/banker-options` | 内置银行家列表 |
| POST | `/banker-character` | 选择/上传银行家图 |
| GET / PUT | `/settings` | 设置读写 |
| GET | `/overview` | 个人中心数据概览（与历史统计同源） |
| POST | `/password` | 修改密码（验证原密码） |
| DELETE | `/user` | 账号注销 |

### 9.3 经济（根路径）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/wallet` | 余额与流水 |
| POST | `/api/signin` | 每日签到（幂等） |
| GET | `/api/tasks` / POST `/api/tasks/:id/claim` | 任务列表 / 领奖 |
| POST | `/api/bailout` | 破产救助（校验余额阈值、每日次数、非对局中） |
| GET | `/api/achievements` / POST `/api/achievements/:id/claim` | 成就列表 / 领取【领取接口为文档外补充】 |

### 9.4 对局 `/api/match`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/tiers` | 档位列表（门槛/上限） |
| POST | `/start` | 开局：事务内扣入场费 + 生成 26 张卡 |
| POST | `/:id/pick` | 选定底牌 |
| POST | `/:id/flip` | 翻牌（校验轮次配额） |
| GET | `/:id/offer` | 触发/获取本轮报价 |
| POST | `/:id/deal` | 接受报价 → 结算 |
| POST | `/:id/counter` | 还价（合法性校验 + 每轮 1 次） |
| POST | `/:id/no-deal` | 拒绝报价 |
| POST | `/:id/swap` | 终局换牌决策 |
| GET | `/:id/state` | 全量状态（掉线重连恢复） |
| GET | `/:id/amount-list` | 面额清单（受设置开关控制） |

### 9.5 历史 `/api/history`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 对局历史列表：`tier` / `result`（profit/loss/even）筛选 + 分页【result 枚举与分页大小为文档外补充】 |
| GET | `/stats` | 统计面板：总局数、累计盈亏、胜率、单局最高盈利、档位分布、累计交税 |

另有 `GET /api/health` 健康检查。

## 10. WebSocket

挂载路径 `/ws/socket.io`，命名空间 `/game`，握手携带 JWT（`auth: { token }`）。

| 方向 | 事件 | 载荷要点 |
| --- | --- | --- |
| 服务端 → 客户端 | `offer_ready` | sessionId、本轮报价（轮次/是否终局/金额分） |
| 服务端 → 客户端 | `flip_result` | sessionId、翻开的牌位与金额（分） |
| 服务端 → 客户端 | `timeout_warning` | sessionId、剩余秒数 |
| 服务端 → 客户端 | `match_settled` | sessionId、状态、结算四件套（税前/盈亏/税/净得，分） |
| 客户端 → 服务端 | `heartbeat` | `{ sessionId }`，重置 5 分钟超时计时 |

事件载荷只含「玩家视图」字段（不泄漏底牌位置等隐藏信息）。前端同时以 REST 轮询兜底，WS 断连不影响对局正确性。

## 11. 阶梯计税（服务端结算）

单局盈利 = 税前奖金 − 入场费；盈利 ≤ 0 记 0、不计税，盈亏不跨局抵扣。起征点 1,000 元，应税部分五级超额累进：

| 级数 | 应税区间 | 税率 | 速算扣除数（代码自动推导） |
| --- | --- | --- | --- |
| 1 | 0 – 5,000 | 3% | 0 |
| 2 | 5,000 – 20,000 | 10% | 350 |
| 3 | 20,000 – 100,000 | 20% | 2,350 |
| 4 | 100,000 – 500,000 | 28% | 10,350 |
| 5 | 500,000 以上 | 35% | 45,350 |

- 配置只存级距 + 税率 + 起征点，扣除数由公式推导（禁止硬编码）。
- 验收示例：盈利 20,000 元 → 应税 19,000 → 19,000 × 10% − 350 = **税 1,550 元**；亏损局税 0。实现在 `game-engine/tax.ts`，单元测试覆盖各级距边界。

## 12. 配置系统

### 12.1 `config/tiers.json` — 档位与卡池

| 键 | 说明 |
| --- | --- |
| `common.flip_sequence` | 轮次翻牌数 `[6,5,4,3,2]`，之后每轮 1 张 |
| `common.anchor_amounts` | 小额锚点 `[0.01, 0.1, 1, 10, 50]`，每档必含、不扰动 |
| `common.pool_jitter` | 非锚点金额扰动幅度（默认 0.25）【文档外补充】 |
| `common.k_ranges` | 报价系数区间：前期 0.55–0.75 / 中期 0.65–0.85 / 终局 0.80–0.95 |
| `common.k_phase_rounds` | 前/中/终局轮次划分（第 1–2 轮前期、3–4 中期、5 起终局）【文档外补充】 |
| `tiers` | 五档定义（键：atm/beginner/standard/advanced/master）：名称、入场费、单局上限、26 张金额模板与权重 |

五档一览（金额：元）：

| 档位 | 入场门槛 | 单局最高奖金 |
| --- | --- | --- |
| 取款机 | 388 | 3,888 |
| 入门档 | 2,000 | 10,000 |
| 标准档 | 20,000 | 100,000 |
| 进阶档 | 80,000 | 500,000 |
| 最高档 | 225,000 | 1,000,000 |

档位判定以开局瞬间账户资金为准，对局中资金变动不影响本局；开局即扣入场费（不返还）。

### 12.2 `config/economy.json` — 经济参数

| 键 | 内容 |
| --- | --- |
| `initial_funds` | 注册初始赠送（默认 10,000 元） |
| `tax` | 计税参数（起征点/级距/税率，见 §11） |
| `signin` | 基础奖励 100 元 + 整数万分比连签倍数：×1.0/×1.2/×1.5/×1.8（4–6 天）/×2.0（7 天起），断签清零，不可补签 |
| `tasks` | 每日 6 项：各档参加 1 次（100/200/500/1000/2000）+ 当日任意 3 局（300），00:00 刷新 |
| `bailout` | 余额 < 388 元可申请，每次 500 元，每日最多 3 次，仅大厅可用 |
| `achievements` | 6 项一次性成就：初出茅庐 150 / 百万梦想 800 / 博弈到底 300 / 东山再起 400 / 连胜猎手 500 / 勤劳玩家 600 |
| `win_streak_guard` | 连胜盈利冻结（可选风控，默认 `null` 关闭）【文档外补充】。启用时 `trigger_profit_fen/keep_ratio_bp/cap_fen/reset_hours` 四项必须全部为正整数，否则服务拒绝启动 |
| `history` | 历史保留期白名单 `[0, 7, 30, 90, 365]` 天（0 = 永久），到期自动清理【文档外补充】 |

所有金额以「元」书写，加载时统一转「分」；非法配置启动期即抛错。

## 13. 前端结构（web/src）

| 目录 | 职责 |
| --- | --- |
| `pages/` | 页面组件（路由见下表） |
| `api/` | REST 客户端 + `gameSocket`（WS 封装，事件与后端逐字段对齐） |
| `store/` | zustand 状态（auth 会话、audio 设置等） |
| `audio/` | audioStore + AudioManager（Howler 单例，BGM 氛围映射 + SFX） |
| `components/` | 通用组件（Layout 含**固定免责声明页脚**） |
| `utils/` | formatMoney（分 → 元显示）等 |

页面路由：

| 路由 | 页面 |
| --- | --- |
| `/login` `/register` `/forgot-password` | 登录 / 注册 / 找回密码 |
| `/lobby` | 游戏大厅：资金、签到、任务、档位、救助、音乐控制 |
| `/match/load/:sessionId` | 对局加载页（银行家 vs 玩家角色） |
| `/match/play/:sessionId` | 对局页（左银行家、右玩家、中央卡牌区） |
| `/match/result/:sessionId` | 结算页（税前奖金/税额/到手/盈亏） |
| `/history` `/achievements` | 对决历史与统计 / 成就页 |
| `/profile` `/profile/character` `/settings` | 个人中心 / 我的角色 / 设置 |

需登录页面有路由守卫；对局页刷新按 sessionId 拉取状态恢复。BGM 氛围映射：加载页 loading → 对局 match → 结算 finale，缺失回退不报错；对局页快捷静音 = 切换 BGM 开关。

## 14. 部署与运维

### 14.1 环境变量（`.env.example`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务端口 |
| `JWT_SECRET` | 空 | JWT 密钥；空值时首次启动自动生成并写回本地 `.env`（生产建议显式注入，避免容器重建后换钥） |
| `DATABASE_URL` | `./data/game.db` | SQLite 路径 |
| `STORAGE_DIR` | `./storage` | 上传文件目录 |
| `USE_REDIS` | `false` | 预留开关 |

### 14.2 启动方式

- **Docker**：`docker compose up -d` → <http://localhost:8080>
- **裸机**：Node 20，`npm install` → `npm run build` → `npm start`（生产入口 `scripts/start-prod.js` 会在缺 `.env` 或密钥为空时自动初始化）
- **开发**：`npm run dev`（自动初始化 `.env` + 后端 watch + 前端热更新）

### 14.3 scripts/

| 脚本 | 用途 |
| --- | --- |
| `init-env.js` | 初始化 `.env` / 自动生成 `JWT_SECRET` |
| `start-prod.js` | 生产入口：先确保 `.env` 就绪再启动 `server/dist/main.js` |
| `reset-password.js` | 本地管理员重置密码脚本 |
| `generate-placeholders.js` | 生成全部占位素材（立绘/BGM/占位图） |
| `clean.js` | 清理构建产物与运行期数据 |

## 15. 测试与工程规范

- **命令**：`npm run lint` / `npm run test`（server + web 全部 Jest）/ `npm run build` / `npm run test:e2e`（Playwright，独立临时库 + 独立端口，不并入 `npm test`）。
- **提交前 lint + test 必须全绿**（CI 同口径：`.github/workflows/ci.yml`）。
- **引擎纯函数必须有单测**（计税、卡池、报价、状态机），e2e 覆盖资金安全（重复扣费、幂等领奖、防负余额）与对局流程；集成测试按 Jest worker 分配独立 SQLite 库隔离。
- **提交信息**：Conventional Commits（feat/fix/chore/docs…）。
- **金额处理红线**：禁止浮点运算参与资金计算；展示层除法仅用于格式化。

## 16. 合规与免责

- 页脚全站固定声明：**「本游戏为纯虚拟娱乐，无任何充值与变现功能，游戏资金无现实价值」**。
- 无充值/提现/付费通道；内置素材全部由 `scripts/generate-placeholders.js` 程序生成（自制占位，无第三方版权内容），见 [README](README.md) 素材与授权一节。
