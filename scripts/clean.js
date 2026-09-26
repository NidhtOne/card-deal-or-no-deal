#!/usr/bin/env node
/**
 * 跨平台目录清理（用法：node scripts/clean.js <目录>）。
 *
 * 为何不用 fs.rmSync(recursive)：Node.js 24.x on Windows 在路径含非 ASCII 字符
 * （如本仓库常见的中文目录）时，fs.rm/promises.rm(recursive) 会直接崩溃
 * （exit 0xC0000409）。手动 readdir + unlink + rmdir 递归无此问题。
 * vite build 清空 outDir 内部即走 fs.rmSync，因此构建前由本脚本先行清理。
 */
const fs = require('fs');
const path = require('path');

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    rmrf(path.join(target, entry.name));
  }
  fs.rmdirSync(target);
}

const dir = process.argv[2];
if (!dir) {
  console.error('[clean] 用法: node scripts/clean.js <目录>');
  process.exit(1);
}
rmrf(path.resolve(process.cwd(), dir));
console.log(`[clean] 已清理 ${dir}`);
