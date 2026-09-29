import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { runInTransaction } from '../common/transaction';
import { FundFlow, FundFlowType } from '../entities/fund-flow.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { WalletInsufficientError, WalletService } from './wallet.service';

/**
 * WalletService.adjustBalance 幂等竞态修复（文档外补充）：
 * 「余额 UPDATE + fund_flows INSERT」由 SAVEPOINT wallet_adjust 包裹，
 * 撞 idem_key UNIQUE 约束时回滚到保存点（本事务对余额零影响）再回查已有流水返回，
 * 杜绝「余额加了两次、流水只有一条」的账实不符。
 *
 * T1/T2/T3 使用真实 better-sqlite3（内存库）验证；mock 场景仅验证 SAVEPOINT 调用时序。
 */

let ds: DataSource;
const service = new WalletService();

async function seedWallet(userId: number, balance: number): Promise<void> {
  await ds.getRepository(UserWallet).save({ userId, balance });
}

async function flowCount(idemKey: string): Promise<number> {
  return ds.getRepository(FundFlow).count({ where: { idemKey } });
}

/**
 * 竞态模拟手法（T1/T2 共用）：better-sqlite3 单连接单写者，两事务天然串行，无法真实复现
 * 「预检查未命中 → insert 撞 UNIQUE」窗口；这里预置流水（或前一次调用先提交），
 * 再把本次调用的首次 FundFlow findOne（预检查）patch 为不可见 —— 等价于
 * 「本次预检查发生在并发请求提交之前」，insert 撞约束走真实或注入的驱动错误。
 */
function patchPreCheckMiss(manager: EntityManager): void {
  const origFindOne = manager.findOne.bind(manager) as (
    entity: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  let flowFindCalls = 0;
  (manager as unknown as Record<string, unknown>).findOne = async (
    entity: unknown,
    options?: unknown,
  ) => {
    if (entity === FundFlow) {
      flowFindCalls += 1;
      if (flowFindCalls === 1) return null; // 预检查未命中
    }
    return origFindOne(entity, options);
  };
}

describe('WalletService.adjustBalance（真实 better-sqlite3）', () => {
  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [UserWallet, FundFlow],
      // 单测专用：仅建本用例涉及的两张表，不经 migrations（migrate 全量由集成测试覆盖）
      synchronize: true,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM fund_flows');
    await ds.query('DELETE FROM user_wallets');
  });

  it('预检查命中已有流水时直接返回其 balanceAfter，余额不变（幂等回归）', async () => {
    await seedWallet(1, 1000);
    await ds.getRepository(FundFlow).save({
      userId: 1,
      amount: 500,
      balanceAfter: 1500,
      type: FundFlowType.Signin,
      idemKey: 'k0',
    });

    const result = await runInTransaction(ds, (manager) =>
      service.adjustBalance(manager, {
        userId: 1,
        delta: 500,
        type: FundFlowType.Signin,
        idemKey: 'k0',
      }),
    );
    expect(result).toBe(1500);
    const wallet = await ds.getRepository(UserWallet).findOneByOrFail({ userId: 1 });
    expect(wallet.balance).toBe(1000);
    expect(await flowCount('k0')).toBe(1);
  });

  it('T1：撞 idem_key UNIQUE 约束 → 返回已有流水 balanceAfter，事务内余额未被改动，提交后流水仅一条', async () => {
    await seedWallet(1, 1000);
    // 预置「并发请求已提交」的流水
    await ds.getRepository(FundFlow).save({
      userId: 1,
      amount: 500,
      balanceAfter: 1500,
      type: FundFlowType.Signin,
      idemKey: 'k1',
    });

    let returned = -1;
    await runInTransaction(ds, async (manager) => {
      patchPreCheckMiss(manager);
      // insert 对 FundFlow 抛 UNIQUE 冲突（驱动错误 message 含 'UNIQUE constraint failed'）
      (manager as unknown as Record<string, unknown>).insert = async (entity: unknown) => {
        if (entity === FundFlow) {
          throw new QueryFailedError(
            'INSERT INTO "fund_flows" ...',
            [],
            new Error('UNIQUE constraint failed: fund_flows.idem_key'),
          );
        }
        throw new Error('unexpected insert');
      };

      returned = await service.adjustBalance(manager, {
        userId: 1,
        delta: 500,
        type: FundFlowType.Signin,
        idemKey: 'k1',
      });

      // 断言②（SQL 级证据）：同一事务内 SELECT 余额未被本次调用改动（保存点已回滚）
      const rows = (await manager.query('SELECT balance FROM user_wallets WHERE user_id = ?', [
        1,
      ])) as { balance: number }[];
      expect(rows[0].balance).toBe(1000);
    });

    // 断言①：返回已有流水的 balanceAfter
    expect(returned).toBe(1500);
    // 断言③：事务提交后 fund_flows 中该 idem_key 仅一条；余额提交后仍未被改动
    expect(await flowCount('k1')).toBe(1);
    const wallet = await ds.getRepository(UserWallet).findOneByOrFail({ userId: 1 });
    expect(wallet.balance).toBe(1000);
  });

  it('T2：同一 idem_key 两次调用 → 余额只变动一次、流水仅一条、两次返回值一致', async () => {
    await seedWallet(2, 1000);

    // 第一次调用：正常完成并提交（真实库真实约束）
    const first = await runInTransaction(ds, (manager) =>
      service.adjustBalance(manager, {
        userId: 2,
        delta: 100,
        type: FundFlowType.Signin,
        idemKey: 'k2',
      }),
    );
    expect(first).toBe(1100);

    // 第二次调用：预检查 patch 为不可见（模拟竞态，见 patchPreCheckMiss 注释），
    // insert 不 patch —— 走真实驱动撞真实 UNIQUE 约束
    const second = await runInTransaction(ds, async (manager) => {
      patchPreCheckMiss(manager);
      return service.adjustBalance(manager, {
        userId: 2,
        delta: 100,
        type: FundFlowType.Signin,
        idemKey: 'k2',
      });
    });

    expect(second).toBe(1100); // 两次返回值一致
    const wallet = await ds.getRepository(UserWallet).findOneByOrFail({ userId: 2 });
    expect(wallet.balance).toBe(1100); // 余额只变动一次
    expect(await flowCount('k2')).toBe(1); // 流水仅一条
  });

  it('T3：余额不足仍抛 WalletInsufficientError，保存点回滚后同一事务可继续写入并成功提交', async () => {
    await seedWallet(3, 1000);

    await runInTransaction(ds, async (manager) => {
      await expect(
        service.adjustBalance(manager, {
          userId: 3,
          delta: -1001,
          type: FundFlowType.Entry,
        }),
      ).rejects.toBeInstanceOf(WalletInsufficientError);

      // 保存点回滚后事务可继续：同一事务内另一笔资金变动成功
      const after = await service.adjustBalance(manager, {
        userId: 3,
        delta: 200,
        type: FundFlowType.Signin,
        idemKey: 'k3',
      });
      expect(after).toBe(1200);
    });

    // 提交后：失败的一笔未入账，成功的一笔已提交
    const wallet = await ds.getRepository(UserWallet).findOneByOrFail({ userId: 3 });
    expect(wallet.balance).toBe(1200);
    const flows = await ds.getRepository(FundFlow).find({ where: { userId: 3 } });
    expect(flows).toHaveLength(1);
    expect(flows[0].idemKey).toBe('k3');
  });
});

describe('WalletService.adjustBalance（mock：SAVEPOINT 调用时序）', () => {
  function buildManager(opts: {
    affected?: number;
    insertError?: Error;
    events: string[];
    firstFindOne?: unknown;
    laterFindOne?: unknown;
  }): EntityManager {
    let findOneCalls = 0;
    return {
      query: jest.fn(async (sql: string) => {
        opts.events.push(sql);
        return [];
      }),
      findOne: jest.fn(async () => {
        opts.events.push('findOne');
        findOneCalls += 1;
        return findOneCalls === 1 ? (opts.firstFindOne ?? null) : (opts.laterFindOne ?? null);
      }),
      createQueryBuilder: jest.fn(() => ({
        update: () => ({
          set: () => ({
            where: () => ({ execute: async () => ({ affected: opts.affected ?? 1 }) }),
          }),
        }),
      })),
      findOneByOrFail: async () => ({ userId: 1, balance: 1100 }),
      insert: jest.fn(async () => {
        opts.events.push('insert');
        if (opts.insertError) throw opts.insertError;
      }),
    } as unknown as EntityManager;
  }

  it('成功路径：SAVEPOINT → RELEASE，无 ROLLBACK', async () => {
    const events: string[] = [];
    const manager = buildManager({ events });
    const result = await service.adjustBalance(manager, {
      userId: 1,
      delta: 100,
      type: FundFlowType.Signin,
      idemKey: 'm1',
    });
    expect(result).toBe(1100);
    expect(events.filter((e) => e.includes('SAVEPOINT'))).toEqual([
      'SAVEPOINT wallet_adjust',
      'RELEASE SAVEPOINT wallet_adjust',
    ]);
  });

  it('撞 idem_key UNIQUE：先 ROLLBACK TO SAVEPOINT 再回查返回（不得 UPDATE 生效后直接返回）', async () => {
    const existing = {
      id: 9,
      userId: 1,
      amount: 100,
      balanceAfter: 1100,
      type: FundFlowType.Signin,
      refId: null,
      idemKey: 'm2',
      createdAt: new Date(),
    } as FundFlow;
    const events: string[] = [];
    const manager = buildManager({
      events,
      laterFindOne: existing,
      insertError: new QueryFailedError(
        'INSERT INTO fund_flows ...',
        [],
        new Error('UNIQUE constraint failed: fund_flows.idem_key'),
      ),
    });

    const result = await service.adjustBalance(manager, {
      userId: 1,
      delta: 100,
      type: FundFlowType.Signin,
      idemKey: 'm2',
    });
    expect(result).toBe(1100);

    // 预检查 → SAVEPOINT → (余额 UPDATE + INSERT 失败) → ROLLBACK TO SAVEPOINT → RELEASE → 回查
    const savepointAt = events.indexOf('SAVEPOINT wallet_adjust');
    const rollbackAt = events.indexOf('ROLLBACK TO SAVEPOINT wallet_adjust');
    const releaseAt = events.indexOf('RELEASE SAVEPOINT wallet_adjust');
    const lookupAt = events.lastIndexOf('findOne');
    expect(savepointAt).toBeGreaterThan(-1);
    expect(rollbackAt).toBeGreaterThan(savepointAt);
    expect(releaseAt).toBeGreaterThan(rollbackAt);
    expect(rollbackAt).toBeLessThan(lookupAt); // 回滚先于回查返回
  });

  it('非 UNIQUE 错误：保存点回滚后原样上抛', async () => {
    const events: string[] = [];
    const manager = buildManager({ events, insertError: new Error('disk I/O error') });
    await expect(
      service.adjustBalance(manager, {
        userId: 1,
        delta: 100,
        type: FundFlowType.Signin,
        idemKey: 'm3',
      }),
    ).rejects.toThrow('disk I/O error');
    expect(events.filter((e) => e.includes('SAVEPOINT'))).toEqual([
      'SAVEPOINT wallet_adjust',
      'ROLLBACK TO SAVEPOINT wallet_adjust',
      'RELEASE SAVEPOINT wallet_adjust',
    ]);
  });

  it('余额不足（UPDATE affected=0）：保存点回滚后抛 WalletInsufficientError', async () => {
    const events: string[] = [];
    const manager = buildManager({ events, affected: 0 });
    await expect(
      service.adjustBalance(manager, {
        userId: 1,
        delta: -999,
        type: FundFlowType.Entry,
      }),
    ).rejects.toBeInstanceOf(WalletInsufficientError);
    expect(events.filter((e) => e.includes('SAVEPOINT'))).toEqual([
      'SAVEPOINT wallet_adjust',
      'ROLLBACK TO SAVEPOINT wallet_adjust',
      'RELEASE SAVEPOINT wallet_adjust',
    ]);
  });
});
