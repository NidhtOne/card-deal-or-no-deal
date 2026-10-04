# 贡献指南

感谢你参与《卡牌一掷千金》的改进。

## 本地开发

1. 安装依赖：`npm install`
2. 启动开发环境：`npm run dev`
3. 访问 `http://localhost:8080`

## 提交前检查

提交代码前必须确保以下命令全部通过：

```bash
npm run lint
npm run test
```

`npm test` 不包含 Playwright 端到端测试。

## 提交信息

请使用 Conventional Commits，例如：

- `feat: 增加新的设置项`
- `fix: 修复对局重连状态`
- `docs: 更新部署说明`
- `test: 补充计税边界测试`
- `chore: 调整工程配置`

## Pull Request 自查清单

- [ ] 改动范围明确，没有混入无关修改
- [ ] `npm run lint` 与 `npm run test` 全绿
- [ ] 涉及金额的逻辑使用整数“分”，没有引入浮点金额运算
- [ ] 资金变动位于数据库事务内，并写入 `fund_flows`
- [ ] 领奖、扣费和结算接口保持幂等
- [ ] 新增游戏数值已放入 `config/tiers.json` 或 `config/economy.json`，没有硬编码
- [ ] 没有提交 `.env`、数据库、上传文件或真实密钥
- [ ] 新增文档外行为已在代码注释中标注“文档外补充”
