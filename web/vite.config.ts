import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as dotenv from 'dotenv';

// 端口参数化：读取仓库根 .env 的 PORT（缺省 8080，文档 8.3），前后端共用同一端口配置。
// 禁止硬编码 8080：8080 被占用（如 Docker Desktop）时只需改 .env 的 PORT，代理同步生效。
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
const backendPort = process.env.PORT?.trim() || '8080';
const httpTarget = `http://localhost:${backendPort}`;

// dev server 代理：/api（REST）、/assets（静态资源）、/ws（socket.io，路径 /ws/socket.io）→ 后端
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: httpTarget,
        changeOrigin: true,
      },
      '/assets': {
        target: httpTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: httpTarget.replace(/^http/, 'ws'),
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // 默认 assetsDir=assets 会与后端托管的 /assets/...（仓库根 assets/）冲突，改用 static
    assetsDir: 'static',
    // Node 24.x + Windows + 非 ASCII 路径下 fs.rmSync(recursive) 崩溃，outDir 由 scripts/clean.js 预清理
    emptyOutDir: false,
  },
});
