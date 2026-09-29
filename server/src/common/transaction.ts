import { DataSource, EntityManager } from 'typeorm';

/**
 * 全局 FIFO 写事务互斥（M2 前置，文档外补充基础设施）。
 *
 * 背景（已实证）：better-sqlite3 驱动的 createQueryRunner 全局共享单实例，
 * 并发 dataSource.transaction() 会互为嵌套 SAVEPOINT —— 内层「提交」不保证持久化、
 * 内层回滚可能误删外层数据。因此进程内用一条 Promise 链把所有写事务串行化（FIFO），
 * 本切片一切写事务（match start / 结算 / 快照落库 / 超时托管）与 M1 的
 * WalletService.adjustBalance 调用方一律经由此入口。
 * better-sqlite3 本是单写者模型，串行化不损失真实并发能力。
 *
 * 规约：全仓库禁止新增裸 dataSource.transaction，一切写事务必须经 runInTransaction
 * （eslint no-restricted-syntax 强制，见 .eslintrc.cjs）。
 * 注意：事务回调 fn 内禁止再等待其他 runInTransaction / 会话队列任务（会自死锁）。
 */

/** 链尾：已入链事务全部完成的 Promise（永不 rejected） */
let tail: Promise<unknown> = Promise.resolve();

/**
 * 串行执行写事务：严格按调用顺序（FIFO）逐个执行 dataSource.transaction(fn)，
 * 前序事务失败不影响后续入链事务。
 */
export function runInTransaction<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  // tail 永不 rejected，前序失败不会跳过本事务
  const result = tail.then(() => dataSource.transaction(fn));
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
