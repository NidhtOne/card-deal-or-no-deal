/**
 * M8-fix1【文档外补充：2026-10-03 人工决策落地】
 * 对局历史按用户保留期清理集成测试。
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

// 库路径由 setup-env 按 JEST_WORKER_ID 分配，禁止在本文件覆盖 DATABASE_URL。
/* eslint-disable @typescript-eslint/no-var-requires */
const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
const { configureApp } = require('../src/main') as typeof import('../src/main');
const { HistoryService } =
  require('../src/history/history.service') as typeof import('../src/history/history.service');
/* eslint-enable @typescript-eslint/no-var-requires */

jest.setTimeout(120000);

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let app: INestApplication;
let dataSource: DataSource;
let baseUrl: string;
let historyService: InstanceType<typeof HistoryService>;
let seq = 0;

interface ApiResult {
  status: number;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  accessToken?: string,
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = (await response.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  } catch {
    // 空响应体
  }
  return { status: response.status, data };
}

function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${seq.toString(36)}`.slice(0, 16);
}

async function register(): Promise<{ token: string; userId: number }> {
  const response = await api('POST', '/auth/register', {
    username: uniq('purge'),
    password: 'abc12345',
    confirmPassword: 'abc12345',
    securityQuestion: '我的小学名称？',
    securityAnswer: '阳光小学',
  });
  expect(response.status).toBe(201);
  return {
    token: response.data.accessToken as string,
    userId: response.data.user.id as number,
  };
}

function dbDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

async function seedSession(
  userId: number,
  ageDays: number,
  netProfit: number,
  suffixMs = 0,
): Promise<number> {
  await dataSource.query(
    `INSERT INTO game_sessions
       (user_id, tier, entry_fee, tier_max_prize, status, timeout_deadline,
        final_bonus, tax, net_profit, finished_at, state_snapshot)
     VALUES (?, 1, 38800, 388800, '成交', 0, ?, 0, ?, ?, '{}')`,
    [userId, 38800 + netProfit, netProfit, dbDate(NOW - ageDays * DAY_MS + suffixMs)],
  );
  const rows = (await dataSource.query('SELECT last_insert_rowid() AS id')) as { id: number }[];
  return Number(rows[0].id);
}

async function countSessions(userId: number): Promise<number> {
  const rows = (await dataSource.query(
    'SELECT COUNT(*) AS count FROM game_sessions WHERE user_id = ?',
    [userId],
  )) as { count: number }[];
  return Number(rows[0].count);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await configureApp(app);
  await app.init();
  const server = await app.listen(0, '127.0.0.1');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('测试服务地址异常');
  baseUrl = `http://127.0.0.1:${address.port}`;
  dataSource = app.get(DataSource);
  historyService = app.get(HistoryService);
});

afterAll(async () => {
  await app?.close();
});

describe('HistoryService.purgeExpired', () => {
  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('retention=0 不删；7 天严格过期删除；30 天用户及多用户互不影响', async () => {
    const a = await register();
    const b = await register();
    const c = await register();

    for (const user of [a, b, c]) {
      await seedSession(user.userId, 8, -100);
      await seedSession(user.userId, 6, 200);
      await seedSession(user.userId, 2, 300);
    }

    expect(
      (await api('PUT', '/user/settings', { historyRetentionDays: 7 }, a.token)).status,
    ).toBe(200);
    expect(
      (await api('PUT', '/user/settings', { historyRetentionDays: 30 }, c.token)).status,
    ).toBe(200);

    expect(await historyService.purgeExpired(NOW)).toBe(1);
    expect(await countSessions(a.userId)).toBe(2);
    expect(await countSessions(b.userId)).toBe(3);
    expect(await countSessions(c.userId)).toBe(3);
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('删除后 list/stats 不含已删局，关联 fund_flows 永久保留', async () => {
    const user = await register();
    const expiredId = await seedSession(user.userId, 8, -100);
    await seedSession(user.userId, 6, 200);
    await seedSession(user.userId, 2, 300);

    await dataSource.query(
      `INSERT INTO fund_flows
         (user_id, amount, balance_after, type, ref_id, idem_key)
       VALUES (?, -100, 999900, '入场', ?, ?)`,
      [user.userId, String(expiredId), `m8-purge-${user.userId}`],
    );
    await api('PUT', '/user/settings', { historyRetentionDays: 7 }, user.token);

    expect(await historyService.purgeExpired(NOW)).toBe(1);

    const list = await api('GET', '/history', undefined, user.token);
    expect(list.status).toBe(200);
    expect(list.data.total).toBe(2);
    expect(list.data.items.map((item: { netProfitFen: number }) => item.netProfitFen)).toEqual([
      300,
      200,
    ]);

    const stats = await api('GET', '/history/stats', undefined, user.token);
    expect(stats.status).toBe(200);
    expect(stats.data.totalMatches).toBe(2);
    expect(stats.data.totalNetProfitFen).toBe(500);

    const flows = (await dataSource.query(
      'SELECT COUNT(*) AS count FROM fund_flows WHERE user_id = ? AND ref_id = ?',
      [user.userId, String(expiredId)],
    )) as { count: number }[];
    expect(Number(flows[0].count)).toBe(1);
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('恰好到期不删（finished_at = now - 7d，删除条件严格小于）', async () => {
    const user = await register();
    await seedSession(user.userId, 7, 100);
    await api('PUT', '/user/settings', { historyRetentionDays: 7 }, user.token);

    expect(await historyService.purgeExpired(NOW)).toBe(0);
    expect(await countSessions(user.userId)).toBe(1);
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('501 条过期记录跨越 500 行批次边界并全部删除', async () => {
    const user = await register();
    await api('PUT', '/user/settings', { historyRetentionDays: 7 }, user.token);

    await dataSource.transaction(async (manager) => {
      for (let i = 0; i < 501; i += 1) {
        await manager.query(
          `INSERT INTO game_sessions
             (user_id, tier, entry_fee, tier_max_prize, status, timeout_deadline,
              final_bonus, tax, net_profit, finished_at, state_snapshot)
           VALUES (?, 1, 38800, 388800, '成交', 0, 38801, 0, 1, ?, '{}')`,
          [user.userId, dbDate(NOW - 8 * DAY_MS - i * 1000)],
        );
      }
    });

    expect(await countSessions(user.userId)).toBe(501);
    expect(await historyService.purgeExpired(NOW)).toBe(501);
    expect(await countSessions(user.userId)).toBe(0);
  });
});
