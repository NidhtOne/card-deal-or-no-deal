import { DataSource } from 'typeorm';
import { runInTransaction } from './transaction';

/**
 * runInTransaction 全局 FIFO 互斥单测（任务书 §0 验收 6）：
 * 并发 20 个写事务（半数内部回滚），断言最终库状态 = 串行执行结果，
 * 且执行顺序严格 FIFO。使用真实 better-sqlite3 内存库。
 */
describe('runInTransaction 全局 FIFO 写事务互斥', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await ds.query('CREATE TABLE tx_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL)');
    await ds.query('CREATE TABLE tx_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)');
    await ds.query('INSERT INTO tx_counter (id, n) VALUES (1, 0)');
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('并发 20 个写事务（10 个回滚）：最终状态 = 串行执行结果，顺序 FIFO', async () => {
    const startedOrder: number[] = [];
    const tasks = Array.from({ length: 20 }, (_, i) =>
      runInTransaction(ds, async (manager) => {
        startedOrder.push(i);
        await manager.query('INSERT INTO tx_log (tag) VALUES (?)', [`tx-${i}`]);
        await manager.query('UPDATE tx_counter SET n = n + 1 WHERE id = 1');
        if (i % 2 === 0) {
          throw new Error(`刻意回滚 tx-${i}`);
        }
      }).catch(() => undefined),
    );
    await Promise.all(tasks);

    // FIFO：执行先后顺序与提交顺序严格一致
    expect(startedOrder).toEqual(Array.from({ length: 20 }, (_, i) => i));

    // 只有奇数索引（10 个）真正提交；自增 id 顺序即提交顺序
    const rows = (await ds.query('SELECT tag FROM tx_log ORDER BY id')) as { tag: string }[];
    expect(rows.map((r) => r.tag)).toEqual(
      Array.from({ length: 10 }, (_, k) => `tx-${2 * k + 1}`),
    );

    // 计数器 = 已提交事务数（嵌套 SAVEPOINT 语义下会出现少计/错删，串行化后精确为 10）
    const counter = (await ds.query('SELECT n FROM tx_counter WHERE id = 1')) as {
      n: number;
    }[];
    expect(counter[0].n).toBe(10);
  });

  it('返回值与异常透传；前序失败不阻断后续事务', async () => {
    await expect(runInTransaction(ds, async () => 42)).resolves.toBe(42);
    await expect(
      runInTransaction(ds, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(runInTransaction(ds, async () => 'ok')).resolves.toBe('ok');
  });
});

/**
 * 跨模块并发污染回归（tx-probe 场景复刻）：
 * 「外层长事务 + 并发内层强制回滚」×20 组 —— 无互斥时内层以 SAVEPOINT 嵌套进外层，
 * 内层回滚静默误删外层数据；收口后一切写事务经 runInTransaction 全局串行，
 * 断言全部外层数据完好、终态 = 串行执行结果、执行时间线无交叉嵌套。
 */
describe('跨模块并发污染回归（tx-probe 复刻）', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await ds.query(
      'CREATE TABLE probe_outer (id INTEGER PRIMARY KEY AUTOINCREMENT, grp INTEGER NOT NULL, step TEXT NOT NULL)',
    );
    await ds.query(
      'CREATE TABLE probe_counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)',
    );
    await ds.query('INSERT INTO probe_counter (id, n) VALUES (1, 0)');
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('外层长事务 × 并发内层强制回滚 ×20 组：外层完好、内层零残留、无交叉嵌套', async () => {
    const timeline: string[] = [];
    const groups = Array.from({ length: 20 }, (_, g) => {
      // 外层长事务：两段写 + 强制拉长窗口（无互斥时内层必然嵌套进来）
      const outer = runInTransaction(ds, async (manager) => {
        timeline.push(`o${g}:begin`);
        await manager.query('INSERT INTO probe_outer (grp, step) VALUES (?, ?)', [g, 'a']);
        await new Promise((r) => setTimeout(r, 10));
        await manager.query('INSERT INTO probe_outer (grp, step) VALUES (?, ?)', [g, 'b']);
        await manager.query('UPDATE probe_counter SET n = n + 1 WHERE id = 1');
        timeline.push(`o${g}:commit`);
      });
      // 并发内层：写入后强制回滚（无互斥时嵌套进外层并误删其未提交数据）
      const inner = runInTransaction(ds, async (manager) => {
        timeline.push(`i${g}:begin`);
        await manager.query('INSERT INTO probe_outer (grp, step) VALUES (?, ?)', [g, 'inner']);
        throw new Error('内层强制回滚');
      }).catch(() => undefined);
      return Promise.all([outer, inner]);
    });
    await Promise.all(groups);

    // 终态 = 串行执行结果：外层 20 组 × 2 行全部完好，内层回滚行 0 残留，计数器恰好 20
    const rows = (await ds.query('SELECT grp, step FROM probe_outer')) as {
      grp: number;
      step: string;
    }[];
    expect(rows).toHaveLength(40);
    expect(rows.filter((r) => r.step === 'inner')).toHaveLength(0);
    const counter = (await ds.query('SELECT n FROM probe_counter WHERE id = 1')) as {
      n: number;
    }[];
    expect(counter[0].n).toBe(20);

    // 无嵌套证据：任一组外层 begin..commit 窗口内不存在其他事务事件
    for (let g = 0; g < 20; g++) {
      const begin = timeline.indexOf(`o${g}:begin`);
      const commit = timeline.indexOf(`o${g}:commit`);
      expect(commit).toBeGreaterThan(begin);
      const interleaved = timeline
        .slice(begin + 1, commit)
        .filter((t) => !t.startsWith(`o${g}:`));
      expect(interleaved).toEqual([]);
    }
  });
});
