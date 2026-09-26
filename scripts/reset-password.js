#!/usr/bin/env node
/**
 * 管理员重置密码脚本（docs/开发文档.md 3.1.1 方式②：本地直接改库）。
 *
 * 用法：node scripts/reset-password.js <用户名> <新密码>
 *
 * - 新密码规则与注册一致：8-20 位且同时包含字母和数字；
 * - 重置成功后吊销该用户全部 Refresh Token；
 * - 数据库路径读取仓库根 .env 的 DATABASE_URL（默认 ./data/game.db，铁律 5）。
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const [, , username, newPassword] = process.argv;
if (!username || !newPassword) {
  console.error('[reset-password] 用法: node scripts/reset-password.js <用户名> <新密码>');
  process.exit(1);
}
if (!/^(?=.*[A-Za-z])(?=.*\d).{8,20}$/.test(newPassword)) {
  console.error('[reset-password] 新密码需为 8-20 位且同时包含字母和数字');
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL || './data/game.db';
const dbPath = path.isAbsolute(dbUrl) ? dbUrl : path.resolve(rootDir, dbUrl);
if (!fs.existsSync(dbPath)) {
  console.error(`[reset-password] 数据库不存在: ${dbPath}（请先启动一次应用完成初始化）`);
  process.exit(1);
}

const db = new Database(dbPath);
try {
  const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
  if (!user) {
    console.error(`[reset-password] 用户不存在: ${username}`);
    process.exit(1);
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    // 重置后吊销全部 Refresh Token，强制重新登录
    db.prepare(
      "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
    ).run(user.id);
  });
  tx();
  console.log(`[reset-password] 已重置用户 ${username} 的密码，并吊销其全部登录令牌`);
} finally {
  db.close();
}
