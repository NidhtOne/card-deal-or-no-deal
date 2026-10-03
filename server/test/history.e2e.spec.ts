/**
 * 对决历史与统计集成测试（M5 阶段 7：docs/开发文档.md 3.10 / 6.3 / 5.2）：
 * 1. 真实完赛局（Deal 成交 / 超时托管）落历史：7 字段齐全、结果映射（成交离场/终局开牌）、
 *    税额与实际盈亏与结算 state 完全一致（复用既有 net_profit 口径，禁止另造计算路径）；
 * 2. 列表倒序（finished_at DESC）、tier/result 筛选（M4 冻结口径 profit>0 / even=0 / loss<0）、
 *    分页（page 从 1 起，pageSize=20，total/totalPages）、越权只能看自己（user_id 强制过滤）；
 * 3. stats 6 项聚合：数字可由单局数据推导（含 0 局空态全 0 不报错）；
 * 4. overview 数据概览三项与 stats 同源；
 * 5. 附录 A 条目 14「无充值、无弃权、入场费不返还」负空间断言：
 *    路由清单无充值/提现/弃权端点（404）、fund_flows type 枚举无「退款」类别、
 *    结算净盈亏 = 到手 − 入场费路径无返还流水。
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { REPO_ROOT } from '../src/config/paths';

jest.setTimeout(120000);

// 独立临时库（必须在加载 AppModule 前设置：data-source 在模块评估时读 env）
const tmpDir = mkdtempSync(join(tmpdir(), 'dond-history-'));
process.env.DATABASE_URL = join(tmpDir, 'test.db');

/* eslint-disable @typescript-eslint/no-var-requires */
const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
const { configureApp } = require('../src/main') as typeof import('../src/main');
const { CLOCK } = require('../src/match/clock') as typeof import('../src/match/clock');
const { GameSessionService } =
  require('../src/match/game-session.service') as typeof import('../src/match/game-session.service');
const { FundFlowType } = require('../src/entities/fund-flow.entity') as typeof import('../src/entities/fund-flow.entity');
/* eslint-enable @typescript-eslint/no-var-requires */

/** 假时钟（复用 match.e2e 范式：注入时钟推进 5 分钟，禁止真实等待） */
class FakeClock {
  private t = Date.now();
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
const fakeClock = new FakeClock();

const TIMEOUT_MS = 5 * 60 * 1000;

let app: INestApplication;
let dataSource: DataSource;
let baseUrl: string;
let sessionService: InstanceType<typeof GameSessionService>;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(fakeClock)
    .compile();
  app = moduleRef.createNestApplication();
  await configureApp(app);
  await app.init();
  const server = await app.listen(0, '127.0.0.1');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('测试服务地址异常');
  baseUrl = `http://127.0.0.1:${address.port}`;
  dataSource = app.get(DataSource);
  sessionService = app.get(GameSessionService);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

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
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  } catch {
    /* 空响应体 */
  }
  return { status: res.status, data };
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  const suffix = `${Date.now().toString(36).slice(-4)}${seq.toString(36)}`;
  return `${prefix}${suffix}`.slice(0, 16);
}

async function registerAndLogin(): Promise<{ token: string; userId: number }> {
  const res = await api('POST', '/auth/register', {
    username: uniq('h'),
    password: 'abc12345',
    confirmPassword: 'abc12345',
    securityQuestion: '我的小学名称？',
    securityAnswer: '阳光小学',
  });
  expect(res.status).toBe(201);
  return { token: res.data.accessToken as string, userId: res.data.user.id as number };
}

/** 真实完赛：tier=1 取款机 → 选底牌 → 翻完第 1 轮 6 张 → 接受首个报价（Deal 结局，路径确定性） */
async function playDealFirstOffer(token: string): Promise<{
  sessionId: number;
  state: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}> {
  const start = await api('POST', '/match/start', { tier: 1 }, token);
  expect(start.status).toBe(201);
  const sessionId = start.data.sessionId as number;
  expect((await api('POST', `/match/${sessionId}/pick`, { index: 0 }, token)).status).toBe(201);
  // 第 1 轮翻 6 张：逐张点未翻牌位 1..6（底牌 0 已封存）
  for (let i = 0; i < 6; i++) {
    const res = await api('POST', `/match/${sessionId}/flip`, { position: i + 1 }, token);
    expect(res.status).toBe(201);
  }
  // 配额耗尽瞬间生成首个报价 → Deal
  const deal = await api('POST', `/match/${sessionId}/deal`, {}, token);
  expect(deal.status).toBe(201);
  return { sessionId, state: deal.data.state as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** 预置一条已结算历史行（白盒直插，口径同 economy.e2e 勤劳玩家用例） */
async function seedSettledRow(opts: {
  userId: number;
  tier: number;
  netProfit: number;
  tax: number;
  status: '成交' | '终局' | '超时结算';
  finishedAt: Date;
}): Promise<void> {
  const finished = opts.finishedAt.toISOString().slice(0, 19).replace('T', ' ');
  await dataSource.query(
    `INSERT INTO game_sessions
       (user_id, tier, entry_fee, tier_max_prize, status, timeout_deadline,
        final_bonus, tax, net_profit, finished_at, state_snapshot)
     VALUES (?, ?, 38800, 388800, ?, 0, ?, ?, ?, ?, '{}')`,
    [opts.userId, opts.tier, opts.status, opts.netProfit + opts.tax + 38800, opts.tax, opts.netProfit, finished],
  );
}

describe('历史列表：真实 Deal 完赛局（3.10 七字段 / 结果映射钦定）', () => {
  it('Deal 成交 → 结果=成交离场，7 字段齐全，税额/盈亏与结算 state 完全一致', async () => {
    const { token } = await registerAndLogin();
    const { state } = await playDealFirstOffer(token);

    const res = await api('GET', '/history', undefined, token);
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(1);
    expect(res.data.items).toHaveLength(1);
    const item = res.data.items[0];
    // 7 字段逐字口径（对局时间精确到分钟）
    expect(Object.keys(item).sort()).toEqual(
      ['entryFeeFen', 'finalAmountFen', 'matchedAt', 'netProfitFen', 'outcome', 'sessionId', 'taxFen', 'tier'].sort(),
    );
    expect(item.tier).toBe(1);
    expect(item.entryFeeFen).toBe(state.entryFeeFen);
    expect(item.outcome).toBe('成交离场'); // settlement.reason='deal' → 成交离场
    expect(item.finalAmountFen).toBe(state.settlement.prizeFen); // 最终报价 = 税前奖金
    expect(item.taxFen).toBe(state.settlement.taxFen);
    expect(item.netProfitFen).toBe(state.netProfitFen); // 到手 − 入场费（既有口径）
    expect(item.netProfitFen).toBe(state.settlement.netFen - state.entryFeeFen);
    // 对局时间精确到分钟（YYYY-MM-DD HH:mm，无秒）
    expect(item.matchedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('历史列表：超时托管完赛局（结果映射钦定：归入终局开牌）', () => {
  it('假时钟推进 5 分钟 → 托管结算落历史，结果=终局开牌（七章.5 固定 keep）', async () => {
    const { token } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 3 }, token);
    fakeClock.advance(TIMEOUT_MS + 1000);
    await sessionService.scanTimeouts();

    const res = await api('GET', '/history', undefined, token);
    expect(res.status).toBe(200);
    const item = res.data.items[0];
    expect(item.outcome).toBe('终局开牌'); // 超时托管固定 keep → 终局开牌
    expect(item.sessionId).toBe(sessionId);
  });
});

describe('历史列表：倒序 / 筛选（tier 1–5、result 枚举）/ 分页（pageSize=20）', () => {
  let token: string;
  let userId: number;

  beforeAll(async () => {
    ({ token, userId } = await registerAndLogin());
    // 预置 23 条已知口径行：覆盖三结果 × 多档位 × 时间倒序（分钟递增）
    const base = new Date('2026-03-01T08:00:00.000Z');
    const plan: Array<{
      tier: number;
      netProfit: number;
      tax: number;
      status: '成交' | '终局' | '超时结算';
    }> = [
      { tier: 1, netProfit: 50000, tax: 1470, status: '成交' }, // 盈利（税>0）
      { tier: 2, netProfit: -120000, tax: 0, status: '终局' }, // 亏损局税额 0
      { tier: 3, netProfit: 0, tax: 0, status: '成交' }, // 保本
      { tier: 1, netProfit: -100, tax: 0, status: '超时结算' }, // 亏损（托管）
      { tier: 5, netProfit: 999999, tax: 30430000 / 100, status: '终局' },
    ];
    for (let i = 0; i < 23; i++) {
      const p = plan[i % plan.length];
      await seedSettledRow({ userId, finishedAt: new Date(base.getTime() + i * 60000), ...p });
    }
  });

  it('未登录访问历史两接口 → 401', async () => {
    expect((await api('GET', '/history')).status).toBe(401);
    expect((await api('GET', '/history/stats')).status).toBe(401);
  });

  it('按 finished_at 倒序（同刻同分按 id 逆序），默认第 1 页 20 条 + total/totalPages', async () => {
    const res = await api('GET', '/history', undefined, token);
    expect(res.status).toBe(200);
    expect(res.data.page).toBe(1);
    expect(res.data.pageSize).toBe(20); // 钦定 pageSize=20（文档未定义，注释标注）
    expect(res.data.total).toBe(23);
    expect(res.data.totalPages).toBe(2);
    expect(res.data.items).toHaveLength(20);
    const times = res.data.items.map((i: { matchedAt: string }) => i.matchedAt);
    const sorted = [...times].sort((a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0));
    expect(times).toEqual(sorted); // 倒序
    // 翻到第 2 页拿余量
    const page2 = await api('GET', '/history?page=2', undefined, token);
    expect(page2.data.items).toHaveLength(3);
    expect(page2.data.page).toBe(2);
    // 越界页返回空列表不报错
    const page9 = await api('GET', '/history?page=9', undefined, token);
    expect(page9.status).toBe(200);
    expect(page9.data.items).toHaveLength(0);
  });

  it('tier 筛选：只返回该档位；tier=6/0/abc → 400', async () => {
    const res = await api('GET', '/history?tier=5', undefined, token);
    expect(res.status).toBe(200);
    expect(res.data.items.length).toBeGreaterThan(0);
    expect(res.data.items.every((i: { tier: number }) => i.tier === 5)).toBe(true);
    for (const bad of ['tier=6', 'tier=0', 'tier=abc']) {
      expect((await api('GET', `/history?${bad}`, undefined, token)).status).toBe(400);
    }
  });

  it('result 筛选：profit>0 / even=0 / loss<0（M4 冻结口径）；非法枚举 → 400', async () => {
    const profit = await api('GET', '/history?result=profit', undefined, token);
    expect(profit.status).toBe(200);
    expect(profit.data.items.every((i: { netProfitFen: number }) => i.netProfitFen > 0)).toBe(true);
    const even = await api('GET', '/history?result=even', undefined, token);
    expect(even.data.items.every((i: { netProfitFen: number }) => i.netProfitFen === 0)).toBe(true);
    const loss = await api('GET', '/history?result=loss', undefined, token);
    expect(loss.data.items.every((i: { netProfitFen: number }) => i.netProfitFen < 0)).toBe(true);
    // 三类计数之和 = 全量（分类完备不重叠）
    expect(profit.data.total + even.data.total + loss.data.total).toBe(23);
    expect((await api('GET', '/history?result=win', undefined, token)).status).toBe(400);
    // 组合筛选
    const combo = await api('GET', '/history?tier=1&result=loss', undefined, token);
    expect(
      combo.data.items.every(
        (i: { tier: number; netProfitFen: number }) => i.tier === 1 && i.netProfitFen < 0,
      ),
    ).toBe(true);
  });

  it('越权：A 的历史对 B 不可见（server 强制 user_id 过滤）', async () => {
    const other = await registerAndLogin();
    const res = await api('GET', '/history', undefined, other.token);
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(0); // 新用户看不到他人 23 条
    const stats = await api('GET', '/history/stats', undefined, other.token);
    expect(stats.data.totalMatches).toBe(0);
  });
});

describe('统计面板 stats（3.10 六项，可由单局数据推导）', () => {
  it('真实单局（Deal）+ 预置行：六项数字与 game_sessions 聚合推导一致', async () => {
    const { token, userId } = await registerAndLogin();
    const { state } = await playDealFirstOffer(token);
    // 预置两条已知行：盈利 200 元 + 亏损 1 元（税 0）
    const base = new Date('2026-04-01T09:00:00.000Z');
    await seedSettledRow({
      userId,
      tier: 3,
      netProfit: 20000,
      tax: 0,
      status: '成交',
      finishedAt: base,
    });
    await seedSettledRow({
      userId,
      tier: 2,
      netProfit: -100,
      tax: 0,
      status: '终局',
      finishedAt: new Date(base.getTime() + 60000),
    });

    const res = await api('GET', '/history/stats', undefined, token);
    expect(res.status).toBe(200);
    const s = res.data;
    // 推导源：真实局 + 2 条预置行
    expect(s.totalMatches).toBe(3);
    const expectedTotal = state.netProfitFen + 20000 - 100;
    expect(s.totalNetProfitFen).toBe(expectedTotal);
    // 胜率：盈利局/完赛总局（保本入分母不算胜）
    const winCount = (state.netProfitFen > 0 ? 1 : 0) + 1;
    expect(s.winRate).toBeCloseTo(winCount / 3, 4);
    expect(s.maxNetProfitFen).toBe(Math.max(state.netProfitFen, 20000));
    expect(s.totalTaxFen).toBe(state.settlement.taxFen);
    // 各档位参与分布：1 档真实局 1，2 档 1，3 档 1，其余 0（1–5 全列）
    expect(s.tierDistribution).toEqual([
      { tier: 1, count: 1 },
      { tier: 2, count: 1 },
      { tier: 3, count: 1 },
      { tier: 4, count: 0 },
      { tier: 5, count: 0 },
    ]);
    // 全部金额为整数分（铁律 4）
    for (const v of [s.totalNetProfitFen, s.maxNetProfitFen, s.totalTaxFen]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('空态：0 局用户统计全 0 不报错', async () => {
    const { token } = await registerAndLogin();
    const res = await api('GET', '/history/stats', undefined, token);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      totalMatches: 0,
      totalNetProfitFen: 0,
      winRate: 0,
      maxNetProfitFen: 0,
      tierDistribution: [
        { tier: 1, count: 0 },
        { tier: 2, count: 0 },
        { tier: 3, count: 0 },
        { tier: 4, count: 0 },
        { tier: 5, count: 0 },
      ],
      totalTaxFen: 0,
    });
    const list = await api('GET', '/history', undefined, token);
    expect(list.data).toMatchObject({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 });
  });
});

describe('数据概览与统计同源（3.2 ↔ 3.10）', () => {
  it('overview 三项 = stats 对应三项（复用同一聚合）', async () => {
    const { token, userId } = await registerAndLogin();
    await seedSettledRow({
      userId,
      tier: 1,
      netProfit: 38800,
      tax: 1134,
      status: '成交',
      finishedAt: new Date('2026-05-01T10:00:00.000Z'),
    });
    const [ov, stats] = await Promise.all([
      api('GET', '/user/overview', undefined, token),
      api('GET', '/history/stats', undefined, token),
    ]);
    expect(ov.status).toBe(200);
    expect(stats.status).toBe(200);
    expect(ov.data.totalMatches).toBe(stats.data.totalMatches);
    expect(ov.data.totalProfit).toBe(stats.data.totalNetProfitFen);
    expect(ov.data.winRate).toBe(stats.data.winRate);
  });
});

describe('附录 A：无充值、无弃权、入场费不返还（负空间断言）', () => {
  it('路由清单无充值/提现/弃权端点（404）', async () => {
    const { token } = await registerAndLogin();
    const { sessionId } = await playDealFirstOffer(token);
    // 弃权/中途退场不存在
    expect((await api('POST', `/match/${sessionId}/quit`, {}, token)).status).toBe(404);
    expect((await api('POST', `/match/${sessionId}/resign`, {}, token)).status).toBe(404);
    expect((await api('POST', `/match/${sessionId}/refund`, {}, token)).status).toBe(404);
    // 充值/提现不存在
    expect((await api('POST', '/wallet/recharge', { amount: 100 }, token)).status).toBe(404);
    expect((await api('POST', '/wallet/withdraw', { amount: 100 }, token)).status).toBe(404);
    expect((await api('POST', '/recharge', { amount: 100 }, token)).status).toBe(404);
  });

  it('fund_flows type 枚举无「退款/充值/提现」类别', async () => {
    // 与 M2/M4 落库口径一致：只有 初始赠送/入场/奖金/税/签到/任务/救助/成就
    const values = Object.values(FundFlowType) as string[];
    expect(values).toEqual(
      expect.arrayContaining(['初始赠送', '入场', '奖金', '税', '签到', '任务', '救助', '成就']),
    );
    for (const banned of ['退款', '充值', '提现', '返还']) {
      expect(values).not.toContain(banned);
    }
  });

  it('结算路径无返还：完赛局流水 type 仅 入场/奖金/税，净盈亏 = 到手 − 入场费', async () => {
    const { token, userId } = await registerAndLogin();
    const { sessionId, state } = await playDealFirstOffer(token);
    const rows = await dataSource.query(
      'SELECT type, amount FROM fund_flows WHERE user_id = ? AND ref_id = ? ORDER BY id',
      [userId, String(sessionId)],
    );
    const types = rows.map((r: { type: string }) => r.type);
    expect(types).toContain('入场');
    expect(types).toContain('奖金');
    for (const t of types) {
      expect(['入场', '奖金', '税']).toContain(t); // 无任何退款类别行
    }
    // 入场费不返还：流水金额和 = 税后到手 − 入场费（唯一资金路径）
    const delta = rows.reduce((acc: number, r: { amount: number }) => acc + Number(r.amount), 0);
    expect(delta).toBe(state.settlement.netFen - state.entryFeeFen);
    expect(delta).toBe(state.netProfitFen);
  });
});
