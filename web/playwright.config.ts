import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E 编排【文档外补充：整个工具链为 M5 阶段 7 新增，不进 npm test（铁律 9 不变）】。
 *
 * - 隔离：E2E 使用独立 DATABASE_URL（临时库文件）+ 独立 STORAGE_DIR + 独立端口起 server，
 *   严禁触碰 ./data/game.db 开发库；每轮 spec 内注册唯一用户名（时间戳后缀）；
 * - 命令 cwd = web/（本配置所在目录）：先构建 server（../server）再以独立环境启动；
 * - 流程见 web/e2e/history.spec.ts（注册 → 上传角色图 → 取款机档完赛 → 签到 → /history 断言）；
 * - 浏览器矩阵仅 Chromium（本地自托管场景，CI 可 headless 跑）。
 */

/** E2E 专用端口（避开 .env 的 PORT 与开发中的 5173/8080） */
const E2E_BACKEND_PORT = 48080;
const E2E_WEB_PORT = 45173;

/** 每轮运行的临时目录（独立库 + 独立上传存储），进程退出时清理 */
const e2eTmpDir = mkdtempSync(join(tmpdir(), 'dond-e2e-'));
const E2E_DATABASE_URL = join(e2eTmpDir, 'e2e.db');
const E2E_STORAGE_DIR = join(e2eTmpDir, 'storage');

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  retries: 0,
  // 单 worker：同一临时库 + 唯一服务实例，避免并发写库（SQLite 单写者）
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${E2E_WEB_PORT}`,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      // 后端：先构建再以独立库/端口/密钥启动（JWT 密钥每轮临时生成，不落仓库，铁律 5）
      command: 'cd ../server && npm run build && node dist/main.js',
      url: `http://localhost:${E2E_BACKEND_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        ...process.env,
        PORT: String(E2E_BACKEND_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
        STORAGE_DIR: E2E_STORAGE_DIR,
        JWT_SECRET: randomBytes(48).toString('hex'),
      },
    },
    {
      // 前端：vite dev server（代理目标由 PORT 环境变量驱动，见 vite.config.ts）
      command: `npx vite --port ${E2E_WEB_PORT} --strictPort`,
      url: `http://localhost:${E2E_WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        PORT: String(E2E_BACKEND_PORT),
      },
    },
  ],
});

/** 进程退出清理临时库与上传目录（严禁残留开发库外数据） */
process.on('exit', () => {
  rmSync(e2eTmpDir, { recursive: true, force: true });
});
