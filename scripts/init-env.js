#!/usr/bin/env node
/**
 * 初始化本地 .env：
 * 1. .env 不存在时从 .env.example 复制生成；
 * 2. JWT_SECRET 为空时生成随机密钥写入本地 .env（见开发文档 8.2/8.3）。
 * 该脚本只写本地 .env（已被 .gitignore 排除），仓库不落任何真实密钥。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const examplePath = path.join(rootDir, '.env.example');

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(examplePath, envPath);
  console.log('[init-env] .env 不存在，已从 .env.example 创建');
}

let content = fs.readFileSync(envPath, 'utf8');
// 注意：\s 会匹配换行符，此处用 [^\S\r\n] 仅匹配行内空白，避免跨行误配
const match = content.match(/^JWT_SECRET[^\S\r\n]*=[^\S\r\n]*(.*)$/m);
const current = match ? match[1].trim() : '';

if (!current) {
  const secret = crypto.randomBytes(48).toString('hex');
  content = match
    ? content.replace(/^JWT_SECRET[^\S\r\n]*=.*$/m, `JWT_SECRET=${secret}`)
    : `${content.trimEnd()}\nJWT_SECRET=${secret}\n`;
  fs.writeFileSync(envPath, content);
  console.log('[init-env] JWT_SECRET 为空，已生成随机密钥写入本地 .env');
} else {
  console.log('[init-env] .env 就绪，JWT_SECRET 已配置');
}
