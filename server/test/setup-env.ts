/**
 * 集成测试环境变量：必须在任何模块导入前生效
 * （data-source.ts / auth.module.ts 在 import 时读取 process.env）。
 */
import { unlinkSync } from 'fs';
import { join, resolve } from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-jwt-secret';

/**
 * 库路径按 jest worker 分配独立文件（./data/test-int-w{workerId}.db）：
 * 根因修复——旧版所有 worker 共享 ./data/test-integration.db，M4 起服期
 * onModuleInit 写事务并发写同一库文件，better-sqlite3 默认 busy_timeout=0
 * 写锁冲突立即抛错，间歇触发 SQLITE_BUSY（database is locked）。
 * 每 worker 独立库后并发写互不相干；同 worker 内多个 spec 串行复用同一库
 * （各套件用唯一用户名，无跨套件断言耦合）。
 * 若环境已显式设置 DATABASE_URL（如 CI 整体指定），保持不覆盖语义。
 * 注 1：不 import src/ 模块，仓库根以本文件位置推导（server/test → 上两级），
 *       与 src/config/paths 同口径。
 * 注 2：用 unlinkSync 而非 rmSync —— 本机（Windows + libuv）rmSync 删
 *       data/ 下文件曾触发原生崩溃（0xC0000409），unlinkSync 实证稳定。
 */
function removeIfExists(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

if (!process.env.DATABASE_URL) {
  const workerId = process.env.JEST_WORKER_ID ?? '0';
  const repoRoot = resolve(__dirname, '..', '..');
  const dbAbs = join(repoRoot, 'data', `test-int-w${workerId}.db`);
  // 同名旧库（含 WAL/SHM 边车）先删除：防上次运行残留数据污染本轮断言
  // （同 worker 内前一 spec 已 close、跨运行旧进程已退出，删除安全）
  for (const suffix of ['', '-wal', '-shm']) {
    removeIfExists(dbAbs + suffix);
  }
  // 相对路径由 data-source.resolveFromRoot 基于仓库根解析
  process.env.DATABASE_URL = `./data/test-int-w${workerId}.db`;
}
