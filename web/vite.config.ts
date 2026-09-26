import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev server 代理：/api（REST）、/assets（静态资源）、/ws（socket.io，路径 /ws/socket.io）→ 后端 8080
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/assets': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
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
