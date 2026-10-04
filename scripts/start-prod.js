#!/usr/bin/env node
/**
 * 生产启动入口【文档外补充：兑现开发文档 8.2「首次启动自动初始化」承诺】。
 *
 * 容器场景推荐显式注入 JWT_SECRET，走守卫分支并避免写盘；也可以挂载持久化
 * .env，避免容器重建后重新生成密钥并使既有登录态失效【文档外补充】。
 */
const { spawn } = require('child_process');
const path = require('path');
if (process.env.JWT_SECRET?.trim()) {
  console.log('[start-prod] 已从环境变量读取 JWT_SECRET，跳过 init-env');
} else {
  /**
   * init-env 是幂等的顶层副作用脚本，只读取 .env 文件内容，不感知 process.env。
   * 必须保留上述守卫，否则在只读文件系统且通过环境变量注入密钥时仍会尝试写盘并崩溃。
   */
  require('./init-env');
}

/**
 * 初始化完成后启动服务端。
 *
 * 不能用 require('../server/dist/main.js')：main.ts 编译产物内含
 * `if (require.main === module) { void bootstrap(); }`，被 require 引入时
 * bootstrap 不会执行，同步代码跑完进程即以 0 退出，容器 restart 策略下
 * 形成无限重启循环。
 *
 * 改为 spawn 子进程直接执行 `node server/dist/main.js`，等效原 start 入口：
 * - init-env 已在子进程启动前同步完成（dotenv 在子进程启动时读取落盘的 .env）；
 * - 子进程 stdio 继承，日志与交互行为不变；
 * - 本进程作为 PID 1 需转发 SIGINT/SIGTERM，让 Nest enableShutdownHooks 优雅退出；
 * - 子进程退出码原样回传（信号退出按 128+signal 惯例），保证 down/重启语义正确。
 */
const serverEntry = path.join(__dirname, '..', 'server', 'dist', 'main.js');
const child = spawn(process.execPath, [serverEntry], {
  stdio: 'inherit',
  env: process.env,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (err) => {
  console.error('[start-prod] 服务端进程启动失败：', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (typeof code === 'number') {
    process.exit(code);
  } else {
    // 信号退出：无子进程可回传信号，按 128+signal 编码退出供编排层识别
    const num = require('os').constants.signals[signal] ?? 15;
    process.exit(128 + num);
  }
});
