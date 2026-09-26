# 项目约定

## 项目简介
《卡牌一掷千金》网页游戏：经典 Deal or No Deal 玩法改编，纯虚拟娱乐，无充值/付费/变现通道。本地自托管单体应用，目标为个人本地部署 + 开源发布。

## 必读文档
- docs/开发文档.md：开发文档（功能、数据库、API、路由、部署）。实现前必读对应章节，严格按章节号执行，不得自行增删规则。
- docs/rules.md：《卡牌一掷千金完整官方游戏规则》V1.1（如有）。

## 技术栈与结构
- Node 20，npm workspaces，成员：server/（NestJS 10 + TypeORM + better-sqlite3，WAL）、web/（React 18 + TypeScript + Vite + Tailwind）。
- 游戏引擎：server/src/game-engine/，纯 TypeScript 模块，禁止 import NestJS 与任何 I/O，随机性通过注入 RNG 实现，独立单元测试。
- 目录（文档 8.1）：config/（tiers.json、economy.json）、assets/{bankers,music,placeholders}/、scripts/、docs/、data/（运行期生成，不入库）、storage/（运行期生成，不入库）。
- 端口 8080；环境变量：PORT / JWT_SECRET / DATABASE_URL(默认 ./data/game.db) / STORAGE_DIR(默认 ./storage) / USE_REDIS(默认 false)。

## 铁律（违反即返工）
1. 一切资金变动必须在数据库事务内完成，并写 fund_flows 流水（type：初始赠送/入场/奖金/税/签到/任务/救助/成就）；领奖/扣费/结算接口必须幂等。
2. 余额 UPDATE 必须带余额条件防负余额；唯一约束 + 幂等键防重复发放。
3. 对局状态服务端权威：卡池、报价、还价判定、结算全部由服务端生成，前端只展示与提交。
4. 金额一律 INTEGER 存储，单位为"分"（卡牌面额含 0.01，禁用浮点）；config 文件中以"元"书写便于阅读，加载时统一转为分。此条覆盖文档 5.1 的 REAL/NUMERIC 写法。
5. 密钥/路径只从 .env 读取，仓库禁止出现真实密钥。
6. 表结构、API 路径、页面路由分别以文档第五、六、四章为准，名称不得擅改；确需新增（如成就领取接口）须在代码注释注明"文档外补充"。
7. 所有游戏数值（档位、金额模板、报价系数、税率、签到、任务、救助、成就）集中在 config/tiers.json 与 config/economy.json，改 JSON 即生效，禁止硬编码。
8. 阶梯税按修正版执行：起征点 1,000 元，五级超额累进 3%/10%/20%/28%/35%，速算扣除数 0/350/2350/10350/45350（代码只存级距+税率+起征点，扣除数自动推导）；验收示例：盈利 20,000 元 → 税 1,550 元，亏损局税 0。文档旧表（0/120/2120/10120/45120）与旧示例（1,520）已作废。
9. 完成任何任务前必须 npm run lint && npm run test 全绿。
10. 页脚固定声明：「本游戏为纯虚拟娱乐，无任何充值与变现功能，游戏资金无现实价值」。