/**
 * M4 经济系统集成测试（docs/开发文档.md 3.8.2–3.8.5 / 6.3 / 七章.6）：
 * 签到（8 天倍数表/断签/幂等）、每日任务（开局即计/领奖幂等/00:00 失效/勤奋玩家）、
 * 破产救助（门槛/对局中/每日 3 次）、成就逐项时序（含超时托管路径、百万梦想边界、
 * 博弈到底仅 swap、东山再起、连胜计数器口径（M8：保本不中断不计入）、
 * 勤劳玩家 100 局（M8 改读 user_game_state 计数器）、总开关 off）、
 * fund_flows 恒定校验（balance_after 链与 wallet 终值一致）。
 * 跨天断言全部用 FakeClock.advance(24h)，禁止真实 sleep。
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import type { MatchSettledPayload } from '../src/match/match-events';

jest.setTimeout(300000);

// 独立临时库（必须在加载 AppModule 前设置：data-source 在模块评估时读 env；
// 库路径由本文件自行管理，setup-env 的 worker 库分配不适用于本套件）
const tmpDir = mkdtempSync(join(tmpdir(), 'dond-economy-'));
process.env.DATABASE_URL = join(tmpDir, 'test.db');

/* eslint-disable @typescript-eslint/no-var-requires */
const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
const { configureApp } = require('../src/main') as typeof import('../src/main');
const { CLOCK } = require('../src/match/clock') as typeof import('../src/match/clock');
const { GameSessionService } =
  require('../src/match/game-session.service') as typeof import('../src/match/game-session.service');
const { AchievementsService } =
  require('../src/economy/achievements.service') as typeof import('../src/economy/achievements.service');
const { getEconomyExt, setEconomyExtCacheForTest } =
  require('../src/config/economy') as typeof import('../src/config/economy');
/* eslint-enable @typescript-eslint/no-var-requires */

/** 假时钟（任务书 §8）：跨天/超时托管全部推进此钟，禁止真实 sleep */
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

const INITIAL_FUNDS_FEN = 1000000; // config/economy.json initial_funds=10000 元 → 分
const DAY_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 5 * 60 * 1000; // 与 service 内 TIMEOUT_MS 一致（3.6.8 钦定 5 分钟）
/** 签到倍数表（config/economy.json，铁律 7：数值以 config 为准，此处为断言钉死值） */
const SIGNIN_EXPECT: { bp: number; rewardFen: number }[] = [
  { bp: 10000, rewardFen: 10000 }, // D1 ×1.0 → 100 元
  { bp: 12000, rewardFen: 12000 }, // D2 ×1.2 → 120 元
  { bp: 15000, rewardFen: 15000 }, // D3 ×1.5 → 150 元
  { bp: 18000, rewardFen: 18000 }, // D4 ×1.8 → 180 元
  { bp: 18000, rewardFen: 18000 }, // D5 ×1.8
  { bp: 18000, rewardFen: 18000 }, // D6 ×1.8（第 6→7 天 ×1.8→×2.0 跳档）
  { bp: 20000, rewardFen: 20000 }, // D7 ×2.0 → 200 元
  { bp: 20000, rewardFen: 20000 }, // D8 ×2.0 封顶
];

let app: INestApplication;
let dataSource: DataSource;
let baseUrl: string;
let sessionService: InstanceType<typeof GameSessionService>;
let achievementsService: InstanceType<typeof AchievementsService>;

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
  let data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  } catch {
    data = {};
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
    username: uniq('e'),
    password: 'abc12345',
    confirmPassword: 'abc12345',
    securityQuestion: '我的小学名称？',
    securityAnswer: '阳光小学',
  });
  expect(res.status).toBe(201);
  return { token: res.data.accessToken as string, userId: res.data.user.id as number };
}

async function balance(userId: number): Promise<number> {
  const rows = await dataSource.query('SELECT balance FROM user_wallets WHERE user_id = ?', [
    userId,
  ]);
  return Number(rows[0].balance);
}

/** 测试辅助：直接调整钱包余额（开局门槛用；不写流水，仅测试白盒） */
async function setBalance(userId: number, fen: number): Promise<void> {
  await dataSource.query('UPDATE user_wallets SET balance = ? WHERE user_id = ?', [fen, userId]);
}

interface FlowRow {
  id: number;
  amount: number;
  balance_after: number;
  type: string;
  ref_id: string | null;
  idem_key: string | null;
}

async function flowsOf(userId: number): Promise<FlowRow[]> {
  return dataSource.query(
    'SELECT id, amount, balance_after, type, ref_id, idem_key FROM fund_flows WHERE user_id = ? ORDER BY id',
    [userId],
  );
}

/**
 * fund_flows 恒定校验（任务 B §5）：断言新流水的 balance_after = 发放前余额 + amount，
 * 且与 wallet 终值一致。
 * 适用范围：无 setBalance 干扰的场景（setBalance 直改钱包不走流水，会破坏全链连续性）。
 */
async function assertNewFlowInvariant(
  userId: number,
  type: string,
  balanceBeforeFen: number,
): Promise<FlowRow> {
  const flows = await flowsOf(userId);
  const news = flows.filter((f) => f.type === type);
  expect(news.length).toBeGreaterThan(0);
  const flow = news[news.length - 1];
  expect(flow.balance_after).toBe(balanceBeforeFen + flow.amount);
  expect(await balance(userId)).toBe(flow.balance_after);
  await assertFlowChainConsistency(userId);
  return flow;
}

/**
 * 全链恒定：首行起点 0（初始赠送），其后逐行 balance_after = 前行 + amount，
 * 末行余额 = wallet 终值。仅在无 setBalance 白盒干预的用例中断言（见上）。
 */
async function assertFlowChainConsistency(userId: number): Promise<void> {
  const flows = await flowsOf(userId);
  let prev = 0;
  for (const f of flows) {
    expect(f.balance_after).toBe(prev + f.amount);
    prev = f.balance_after;
  }
  expect(prev).toBe(await balance(userId));
}

/**
 * 局部恒定校验（setBalance 白盒干预过的用例专用）：只断言本次发放新流水的
 * balance_after = 发放前余额 + amount 且与 wallet 终值一致，不校验全链连续性。
 */
async function assertGrantFlowOnly(
  userId: number,
  type: string,
  balanceBeforeFen: number,
): Promise<FlowRow> {
  const flows = await flowsOf(userId);
  const news = flows.filter((f) => f.type === type);
  expect(news.length).toBeGreaterThan(0);
  const flow = news[news.length - 1];
  expect(flow.balance_after).toBe(balanceBeforeFen + flow.amount);
  expect(await balance(userId)).toBe(flow.balance_after);
  return flow;
}
async function eventually<T>(
  fn: () => Promise<T | false | undefined | null>,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('eventually 轮询超时');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** 逐张翻完当前轮（跳过底牌/已翻位），返回配额耗尽转入报价后的最新 state */
async function flipWholeRound(sessionId: number, token: string): Promise<Record<string, any>> {
  let st = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
  const taken = new Set<number>(
    (st.flippedCards as { position: number }[]).map((c) => c.position),
  );
  if (typeof st.ownCardPosition === 'number') taken.add(st.ownCardPosition);
  for (let p = 0; p < 26; p++) {
    if (st.engineStatus !== 'FLIP_ROUND_N') break;
    if (taken.has(p)) continue;
    const res = await api('POST', `/match/${sessionId}/flip`, { position: p }, token);
    expect(res.status).toBe(201);
    taken.add(p);
    st = res.data.state;
  }
  return st;
}

/** 白盒读卡池（含位置与金额；测试专用——服务端机密不出 API，只从 DB 读） */
async function poolOf(sessionId: number): Promise<{ position: number; amount: number }[]> {
  return dataSource.query(
    'SELECT position, amount FROM game_cards WHERE session_id = ? ORDER BY position',
    [sessionId],
  );
}

/**
 * 快速结算一局（还价必接受路径）：还价 = 剩余卡（含底牌）最低面额，
 * 恒 ≤ 0.85EV → 必接受，秒成交。prize = 剩余最小面额（atm 档通常 1 分锚点）
 * → 确定性大额亏损（用于「完成一局/截断连胜/亏损场景」）。
 */
async function quickSettle(
  token: string,
  tier = 1,
): Promise<{ sessionId: number; settlement: Record<string, any>; state: Record<string, any> }> {
  const start = await api('POST', '/match/start', { tier }, token);
  expect(start.status).toBe(201);
  const sessionId = start.data.sessionId as number;
  await api('POST', `/match/${sessionId}/pick`, { index: 0 }, token);
  await flipWholeRound(sessionId, token);
  const remaining = (await dataSource.query(
    "SELECT amount FROM game_cards WHERE session_id = ? AND state != '已淘汰'",
    [sessionId],
  )) as { amount: number }[];
  expect(remaining.length).toBeGreaterThan(0);
  const minFen = Math.min(...remaining.map((r) => r.amount));
  const res = await api('POST', `/match/${sessionId}/counter`, { counter: minFen }, token);
  expect(res.status).toBe(201);
  expect(res.data.state.settlement.reason).toBe('counter');
  return { sessionId, settlement: res.data.state.settlement, state: res.data.state };
}

/**
 * 拒绝到底终局结算（keep 路径）：白盒选最大/最小面额为底牌 → 全程拒绝报价 →
 * 终局 swap:false 保留底牌。prize = 所选底牌面额（确定性：atm 最大卡被上限钳制恒 388800 分，
 * master 最大卡恒 100000000 分；最小卡为锚点 1 分）。
 */
async function playKeepEnd(
  token: string,
  tier: number,
  pickMax: boolean,
  expectOriginalPrize = true,
): Promise<{ sessionId: number; settlement: Record<string, any> }> {
  const start = await api('POST', '/match/start', { tier }, token);
  expect(start.status).toBe(201);
  const sessionId = start.data.sessionId as number;
  const pool = await poolOf(sessionId);
  const target = pickMax
    ? pool.reduce((a, b) => (b.amount > a.amount ? b : a))
    : pool.reduce((a, b) => (b.amount < a.amount ? b : a));
  await api('POST', `/match/${sessionId}/pick`, { index: target.position }, token);

  let state = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
  let guard = 0;
  while (state.engineStatus !== 'SETTLE') {
    guard += 1;
    expect(guard).toBeLessThan(60);
    if (state.engineStatus === 'FLIP_ROUND_N') {
      state = await flipWholeRound(sessionId, token);
    } else if (state.engineStatus === 'BANKER_OFFER' || state.engineStatus === 'FINAL_OFFER') {
      state = (await api('POST', `/match/${sessionId}/no-deal`, {}, token)).data.state;
    } else if (state.engineStatus === 'SWAP_DECISION') {
      state = (await api('POST', `/match/${sessionId}/swap`, { swap: false }, token)).data.state;
    } else {
      throw new Error(`意外状态 ${state.engineStatus}`);
    }
  }
  expect(state.settlement.reason).toBe('keep');
  if (expectOriginalPrize) {
    expect(state.settlement.prizeFen).toBe(target.amount);
  }
  return { sessionId, settlement: state.settlement };
}

/** M8【文档外补充：2026-10-03 人工决策落地】：直接读 user_game_state 计数器行 */
async function gameStateRow(userId: number): Promise<{
  win_streak: number;
  streak_profit_fen: number;
  guard_frozen: number;
  guard_triggered_at: number | null;
  total_settled_games: number;
}> {
  const rows = (await dataSource.query(
    'SELECT win_streak, streak_profit_fen, guard_frozen, guard_triggered_at, total_settled_games FROM user_game_state WHERE user_id = ?',
    [userId],
  )) as Record<string, number | null>[];
  if (rows.length === 0) {
    return {
      win_streak: 0,
      streak_profit_fen: 0,
      guard_frozen: 0,
      guard_triggered_at: null,
      total_settled_games: 0,
    };
  }
  const r = rows[0];
  return {
    win_streak: Number(r.win_streak),
    streak_profit_fen: Number(r.streak_profit_fen),
    guard_frozen: Number(r.guard_frozen),
    guard_triggered_at: r.guard_triggered_at === null ? null : Number(r.guard_triggered_at),
    total_settled_games: Number(r.total_settled_games),
  };
}

/** GET /api/achievements → code 索引视图 */
async function achMap(
  token: string,
): Promise<{ enabled: boolean; byCode: Map<string, Record<string, any>> }> {
  const res = await api('GET', '/achievements', undefined, token);
  expect(res.status).toBe(200);
  return {
    enabled: res.data.enabled as boolean,
    byCode: new Map(
      (res.data.list as Record<string, any>[]).map((it) => [it.code as string, it]),
    ),
  };
}

async function isUnlocked(token: string, code: string): Promise<boolean> {
  const { byCode } = await achMap(token);
  return byCode.get(code)?.unlocked === true;
}

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
  achievementsService = app.get(AchievementsService);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('每日签到（3.8.2；附录 A：签到倍数 ×1.0/×1.2/×1.5/×1.8/×2.0，断签清零）', () => {
  it('连续 8 天逐天签到：multiplierBp/rewardFen 按倍数表（含 D6→D7 ×1.8→×2.0 跳档），流水链恒定', async () => {
    const { token, userId } = await registerAndLogin();
    let prevBalance = await balance(userId);

    for (let day = 1; day <= 8; day++) {
      const res = await api('POST', '/signin', undefined, token);
      expect(res.status).toBe(201);
      expect(res.data.signed).toBe(true);
      expect(res.data.streakDays).toBe(day);
      expect(res.data.multiplierBp).toBe(SIGNIN_EXPECT[day - 1].bp);
      expect(res.data.rewardFen).toBe(SIGNIN_EXPECT[day - 1].rewardFen);
      expect(res.data.balanceFen).toBe(prevBalance + res.data.rewardFen);
      await assertNewFlowInvariant(userId, '签到', prevBalance);
      prevBalance = res.data.balanceFen as number;
      fakeClock.advance(DAY_MS); // 跨天全部推进假时钟
    }

    // 8 天合计流水恰 1+8 条（初始赠送 + 每日 1 条签到）
    const flows = await flowsOf(userId);
    expect(flows.filter((f) => f.type === '签到')).toHaveLength(8);
  });

  it('断签清零：D1 签 → 跳过 D2 → D3 签 streakDays=1（倍数回 ×1.0）', async () => {
    const { token } = await registerAndLogin();
    const d1 = await api('POST', '/signin', undefined, token);
    expect(d1.status).toBe(201);
    fakeClock.advance(2 * DAY_MS); // 跳过 D2 整天
    const d3 = await api('POST', '/signin', undefined, token);
    expect(d3.status).toBe(201);
    expect(d3.data.streakDays).toBe(1);
    expect(d3.data.multiplierBp).toBe(10000);
    expect(d3.data.rewardFen).toBe(10000);
  });

  it('同日重复签到幂等：signed:false 返回既有奖励，当日签到流水仅 1 条、余额不双加', async () => {
    const { token, userId } = await registerAndLogin();
    const first = await api('POST', '/signin', undefined, token);
    expect(first.status).toBe(201);
    const afterFirst = await balance(userId);

    const dup = await api('POST', '/signin', undefined, token);
    expect(dup.status).toBe(201);
    expect(dup.data.signed).toBe(false);
    expect(dup.data.rewardFen).toBe(first.data.rewardFen);
    expect(dup.data.balanceFen).toBe(afterFirst);

    const signinFlows = (await flowsOf(userId)).filter(
      (f) => f.type === '签到' && f.idem_key === `signin:${userId}:${first.data.signDate}`,
    );
    expect(signinFlows).toHaveLength(1);
    expect(await balance(userId)).toBe(afterFirst);
  });
});

describe('每日任务（3.8.3 / 七章.6）', () => {
  it('start(tier=3) 开局扣费成功即计数：standard_1 与 grind_3 progress=1，其余档位任务 0', async () => {
    const { token, userId } = await registerAndLogin();
    await setBalance(userId, 10000000); // 标准档入场 2,000,000 分
    const start = await api('POST', '/match/start', { tier: 3 }, token);
    expect(start.status).toBe(201);

    // match_started 异步消费：轮询至 standard_1 落库
    await eventually(async () => {
      const res = await api('GET', '/tasks', undefined, token);
      return res.data.tasks.find((t: { code: string }) => t.code === 'standard_1')?.progress === 1;
    });
    const tasks = (await api('GET', '/tasks', undefined, token)).data.tasks as Record<
      string,
      any
    >[];
    const byCode = new Map(tasks.map((t) => [t.code as string, t]));
    expect(byCode.get('standard_1')).toMatchObject({ progress: 1, target: 1, completed: true, claimed: false, claimable: true });
    expect(byCode.get('grind_3')).toMatchObject({ progress: 1, target: 3, completed: false, claimable: false });
    // 七章.6：仅同档位 + 任意档位任务计数，其余档位任务进度为 0
    for (const code of ['atm_1', 'beginner_1', 'advanced_1', 'master_1']) {
      expect(byCode.get(code)).toMatchObject({ progress: 0, completed: false, claimable: false });
    }
  });

  it('达标领奖：奖励入账 + 流水正确；重复 claim alreadyClaimed:true 且流水仍 1 条、余额不变', async () => {
    const { token, userId } = await registerAndLogin();
    await quickSettle(token, 1); // atm_1 达标（target=1）
    await eventually(async () => {
      const res = await api('GET', '/tasks', undefined, token);
      return res.data.tasks.find((t: { code: string }) => t.code === 'atm_1')?.claimable === true;
    });

    const before = await balance(userId);
    const claim = await api('POST', '/tasks/atm_1/claim', {}, token);
    expect(claim.status).toBe(201);
    expect(claim.data.alreadyClaimed).toBe(false);
    expect(claim.data.rewardFen).toBe(10000); // 100 元 → 分
    const flow = await assertNewFlowInvariant(userId, '任务', before);
    expect(flow.idem_key!.startsWith(`task:${userId}:`)).toBe(true);
    expect(flow.idem_key!.endsWith(':atm_1')).toBe(true);

    const afterClaim = await balance(userId);
    const dup = await api('POST', '/tasks/atm_1/claim', {}, token);
    expect(dup.status).toBe(201);
    expect(dup.data.alreadyClaimed).toBe(true);
    expect(dup.data.rewardFen).toBe(10000);
    expect(dup.data.balanceFen).toBe(afterClaim);
    expect((await flowsOf(userId)).filter((f) => f.type === '任务')).toHaveLength(1);
    expect(await balance(userId)).toBe(afterClaim);
  });

  it('FakeClock 跨 00:00 后 claim 昨日已完成未领取的任务 → 400（刷新失效不补发）', async () => {
    const { token } = await registerAndLogin();
    await quickSettle(token, 1);
    await eventually(async () => {
      const res = await api('GET', '/tasks', undefined, token);
      return res.data.tasks.find((t: { code: string }) => t.code === 'atm_1')?.claimable === true;
    });

    fakeClock.advance(DAY_MS); // 跨 00:00
    const claim = await api('POST', '/tasks/atm_1/claim', {}, token);
    expect(claim.status).toBe(400);
    expect(String(claim.data.message)).toContain('失效');

    // 新一天任务进度归零（昨日行不参与今日视图）
    const tasks = (await api('GET', '/tasks', undefined, token)).data.tasks as Record<string, any>[];
    expect(tasks.find((t) => t.code === 'atm_1')).toMatchObject({ progress: 0, claimable: false });
  });

  it('勤奋玩家：当日第 3 局 start 后 claim 成功（开局即计，非结算计）', async () => {
    const { token, userId } = await registerAndLogin();
    await quickSettle(token, 1);
    await quickSettle(token, 1);
    // 第 3 局：仅 start（不结算），验证开局即计
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    expect(start.status).toBe(201);
    await eventually(async () => {
      const res = await api('GET', '/tasks', undefined, token);
      return res.data.tasks.find((t: { code: string }) => t.code === 'grind_3')?.claimable === true;
    });

    const before = await balance(userId);
    const claim = await api('POST', '/tasks/grind_3/claim', {}, token);
    expect(claim.status).toBe(201);
    expect(claim.data.rewardFen).toBe(30000); // 300 元 → 分
    await assertNewFlowInvariant(userId, '任务', before);
  });
});

describe('破产救助（3.8.4；附录 A：破产救助 500/次、每日 3 次、<388 可用、对局中不可用）', () => {
  it('余额恰为 38800 分（388 元整）→ 拒绝（严格小于才可申请）', async () => {
    const { token, userId } = await registerAndLogin();
    await setBalance(userId, 38800);
    const res = await api('POST', '/bailout', undefined, token);
    expect(res.status).toBe(400);
    expect(await balance(userId)).toBe(38800);
  });

  it('存在 status=进行中 对局 → 拒绝（余额先压线下再验对局中拦截）', async () => {
    const { token, userId } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    expect(start.status).toBe(201);
    await setBalance(userId, 100); // 压线下，排除余额门槛干扰
    const res = await api('POST', '/bailout', undefined, token);
    expect(res.status).toBe(409);
    expect(await balance(userId)).toBe(100);
  });

  it('余额压到线下连申 3 次成功：第 2、3 次 needsReminder=true，第 4 次拒绝；救助流水恰 3 条', async () => {
    const { token, userId } = await registerAndLogin();
    for (let i = 1; i <= 3; i++) {
      await setBalance(userId, 100); // 每次入账 500 元后重回线上，须再压线下（白盒干预：仅局部恒定）
      const before = await balance(userId);
      const res = await api('POST', '/bailout', undefined, token);
      expect(res.status).toBe(201);
      expect(res.data.timesUsed).toBe(i);
      expect(res.data.remaining).toBe(3 - i);
      expect(res.data.needsReminder).toBe(i >= 2); // 第 2、3 次提醒
      expect(res.data.amountFen).toBe(50000);
      await assertGrantFlowOnly(userId, '救助', before);
    }
    expect((await flowsOf(userId)).filter((f) => f.type === '救助')).toHaveLength(3);

    await setBalance(userId, 100); // 仍线下，但每日次数已用完
    const fourth = await api('POST', '/bailout', undefined, token);
    expect(fourth.status).toBe(400);
    expect((await flowsOf(userId)).filter((f) => f.type === '救助')).toHaveLength(3);
  });
});

describe('成就：初出茅庐（超时托管结算路径）', () => {
  it('advance 5 分钟托管结算也解锁 first_match', async () => {
    const { token } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    expect(start.status).toBe(201);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 7 }, token);

    fakeClock.advance(TIMEOUT_MS + 1000);
    await sessionService.scanTimeouts();

    const st = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
    expect(st.status).toBe('超时结算');
    await eventually(async () => isUnlocked(token, 'first_match'));
    const { byCode } = await achMap(token);
    expect(byCode.get('first_match')).toMatchObject({ unlocked: true, claimed: false });
  });
});

describe('成就：百万梦想（单局税前奖金 ≥ 1,000,000 元）', () => {
  it('白盒直驱结算事件：prizeFen = 100,000,000 分恰在门槛（含等号）解锁', async () => {
    const { token, userId } = await registerAndLogin();
    const payload: MatchSettledPayload = {
      userId,
      sessionId: 0,
      tier: 5,
      status: '终局',
      timeout: false,
      settlement: {
        reason: 'keep',
        prizeFen: 100000000,
        profitFen: 77500000,
        taxFen: 0,
        netFen: 100000000,
      },
      netProfitFen: 77500000,
      settledBalanceFen: 0,
    };
    const gained = await achievementsService.evaluateOnSettled(payload);
    expect(gained).toContain('million_dream');
    expect(await isUnlocked(token, 'million_dream')).toBe(true);
  });

  it('税前奖金 99,999,999 分不解锁（白盒直驱结算事件，与真实路径同一判定事务）', async () => {
    const { token, userId } = await registerAndLogin();
    const payload: MatchSettledPayload = {
      userId,
      sessionId: 0,
      tier: 5,
      status: '终局',
      timeout: false,
      settlement: {
        reason: 'keep',
        prizeFen: 99999999,
        profitFen: 77499999,
        taxFen: 0,
        netFen: 99999999,
      },
      netProfitFen: 77499999,
      settledBalanceFen: 0,
    };
    const gained = await achievementsService.evaluateOnSettled(payload);
    expect(gained).not.toContain('million_dream');
    expect(await isUnlocked(token, 'million_dream')).toBe(false);
  });

  it('master 档终局保留最大卡：prizeFen ≥ 100,000,000 分真实解锁（上限卡被钳制恒在门槛之上）', async () => {
    const { token, userId } = await registerAndLogin();
    await setBalance(userId, 30000000); // master 入场 22,500,000 分
    const { settlement } = await playKeepEnd(token, 5, true);
    // master 最大模板卡扰动后恒被钳制到档位上限 100,000,000 分；若次大卡先占上限值，
    // 唯一性修复 +1 优先向上探测（仍 ≤ cap）→ 池内最大卡 ≥ 100,000,000 分恒成立
    expect(settlement.prizeFen).toBeGreaterThanOrEqual(100000000);
    await eventually(async () => isUnlocked(token, 'million_dream'));
    expect(userId).toBeGreaterThan(0);
  });
});

describe('成就：博弈到底（仅终局换牌结算解锁，任务 C 钦定）', () => {
  /** 全拒报价到底 + 终局换牌决策（swap 为 true/false） */
  async function playToEndWithSwap(
    token: string,
    swap: boolean,
  ): Promise<{ sessionId: number; settlement: Record<string, any> }> {
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    expect(start.status).toBe(201);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 2 }, token);
    let state = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
    let guard = 0;
    while (state.engineStatus !== 'SETTLE') {
      guard += 1;
      expect(guard).toBeLessThan(60);
      if (state.engineStatus === 'FLIP_ROUND_N') {
        state = await flipWholeRound(sessionId, token);
      } else if (state.engineStatus === 'BANKER_OFFER' || state.engineStatus === 'FINAL_OFFER') {
        state = (await api('POST', `/match/${sessionId}/no-deal`, {}, token)).data.state;
      } else if (state.engineStatus === 'SWAP_DECISION') {
        state = (await api('POST', `/match/${sessionId}/swap`, { swap }, token)).data.state;
      } else {
        throw new Error(`意外状态 ${state.engineStatus}`);
      }
    }
    expect(state.settlement.reason).toBe(swap ? 'swap' : 'keep');
    return { sessionId, settlement: state.settlement };
  }

  it('全拒报价 + 终局 swap:true 解锁 never_deal', async () => {
    const { token } = await registerAndLogin();
    const { settlement } = await playToEndWithSwap(token, true);
    expect(settlement.reason).toBe('swap');
    await eventually(async () => isUnlocked(token, 'never_deal'));
  });

  it('终局 keep（不换牌）不解锁 never_deal', async () => {
    const { token } = await registerAndLogin();
    const { settlement } = await playToEndWithSwap(token, false);
    expect(settlement.reason).toBe('keep');
    // 同步点：keep 结算同一判定事务必解锁 first_match，其落库即本轮判定已提交
    await eventually(async () => isUnlocked(token, 'first_match'));
    expect(await isUnlocked(token, 'never_deal')).toBe(false);
  });

  it('超时托管局固定保留底牌（reason=keep），永不触发 never_deal（有意为之）', async () => {
    const { token } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 3 }, token);
    fakeClock.advance(TIMEOUT_MS + 1000);
    await sessionService.scanTimeouts();
    const st = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
    expect(st.settlement.reason).toBe('keep');
    await eventually(async () => isUnlocked(token, 'first_match'));
    expect(await isUnlocked(token, 'never_deal')).toBe(false);
  });
});

describe('成就：东山再起（救助后盈利局）', () => {
  it('未领过救助的盈利局不解锁', async () => {
    const { token } = await registerAndLogin();
    await playKeepEnd(token, 1, true); // 确定性盈利局（atm 上限卡 388800 分）
    await eventually(async () => isUnlocked(token, 'first_match'));
    expect(await isUnlocked(token, 'comeback')).toBe(false);
  });

  it('领救助 → 亏损局 → 盈利局 解锁；资格持久（领救助后连续亏损多局再盈利仍解锁）', async () => {
    const { token, userId } = await registerAndLogin();
    await setBalance(userId, 100);
    const bailout = await api('POST', '/bailout', undefined, token);
    expect(bailout.status).toBe(201);

    // 连续亏损 2 局（还价最低面额秒成交：prize=1 分级亏损）
    await setBalance(userId, 1000000);
    await quickSettle(token, 1);
    await quickSettle(token, 1);
    expect(await isUnlocked(token, 'comeback')).toBe(false);

    // 资格持久：盈利局结算后解锁
    await playKeepEnd(token, 1, true);
    await eventually(async () => isUnlocked(token, 'comeback'));
  });
});

describe('成就：连胜猎手（M8 改读 user_game_state.win_streak【文档外补充：2026-10-03 人工决策落地】，口径：盈利 +1、亏损清零、保本不中断不计入）', () => {
  it('盈×5 解锁', async () => {
    const { token, userId } = await registerAndLogin();
    for (let i = 0; i < 4; i++) {
      await playKeepEnd(token, 1, true);
      expect(await isUnlocked(token, 'win_streak')).toBe(false);
    }
    await playKeepEnd(token, 1, true); // 第 5 连盈
    await eventually(async () => isUnlocked(token, 'win_streak'));
    expect((await gameStateRow(userId)).win_streak).toBe(5);
  });

  it('盈利后插入亏损局再盈×5 重新达成解锁（亏损清零，重新累计）', async () => {
    const { token, userId } = await registerAndLogin();
    await playKeepEnd(token, 1, true); // 盈 1
    await quickSettle(token, 1); // 亏损清零
    expect((await gameStateRow(userId)).win_streak).toBe(0);
    await setBalance(userId, 1000000);
    for (let i = 0; i < 4; i++) {
      await playKeepEnd(token, 1, true);
      expect(await isUnlocked(token, 'win_streak')).toBe(false);
    }
    await playKeepEnd(token, 1, true); // 亏损后重新连盈第 5 局
    await eventually(async () => isUnlocked(token, 'win_streak'));
    expect((await gameStateRow(userId)).win_streak).toBe(5);
  });

  it('「盈、保本、盈×4」序列解锁（保本不中断连胜延续，但保本局本身不计入）', async () => {
    const { token, userId } = await registerAndLogin();
    await playKeepEnd(token, 1, true); // 盈 → win_streak=1
    // 保本局：还价恰 = 入场费 38800 分（≥ 剩余最低面额且 ≤ 0.85EV → 必接受；profit=0 无税）
    {
      const start = await api('POST', '/match/start', { tier: 1 }, token);
      const sessionId = start.data.sessionId as number;
      await api('POST', `/match/${sessionId}/pick`, { index: 0 }, token);
      await flipWholeRound(sessionId, token);
      const res = await api('POST', `/match/${sessionId}/counter`, { counter: 38800 }, token);
      expect(res.status).toBe(201);
      expect(res.data.state.settlement.prizeFen).toBe(38800);
      expect(res.data.state.netProfitFen).toBe(0); // 保本
    }
    // 保本不中断不计入：win_streak 保持 1、结算局数 +1（M8 钦定口径，注释标注）
    const afterEven = await gameStateRow(userId);
    expect(afterEven.win_streak).toBe(1);
    expect(afterEven.total_settled_games).toBe(2);
    for (let i = 0; i < 3; i++) {
      await playKeepEnd(token, 1, true);
      expect(await isUnlocked(token, 'win_streak')).toBe(false);
    }
    await playKeepEnd(token, 1, true); // 跨保本延续的第 5 连盈 → 解锁
    await eventually(async () => isUnlocked(token, 'win_streak'));
    const finalState = await gameStateRow(userId);
    expect(finalState.win_streak).toBe(5);
    expect(finalState.total_settled_games).toBe(6);
  });
});

describe('成就：勤劳玩家（累计 100 局，托管局计数同样有效；M8 改读 total_settled_games 计数器【文档外补充：2026-10-03 人工决策落地】）', () => {
  it('预置计数器 99 + 第 100 局超时托管结算解锁（造 user_game_state 行替代造 game_sessions 行）', async () => {
    const { token, userId } = await registerAndLogin();
    // M8 改造：不再回扫 game_sessions（历史清理会物理删行），改预置计数器行
    await dataSource.query(
      'INSERT INTO user_game_state (user_id, total_settled_games) VALUES (?, 99)',
      [userId],
    );

    // 第 100 局：超时托管结算（托管局同样计入 total_settled_games）
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 5 }, token);
    fakeClock.advance(TIMEOUT_MS + 1000);
    await sessionService.scanTimeouts();
    const st = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
    expect(st.status).toBe('超时结算');
    expect((await gameStateRow(userId)).total_settled_games).toBe(100);

    await eventually(async () => isUnlocked(token, 'hundred_games'));
  });
});

describe('成就：achievement_enabled=off（判定照常落库待领取；附录 A：成就 6 项一次性解锁——本 describe 与初出茅庐/百万梦想/博弈到底/东山再起/连胜猎手/勤劳玩家六个 describe + 领取幂等回放共同覆盖）', () => {
  it('off 时解锁照常落库（unclaimed）；重新开启后 list 可见、claim 成功', async () => {
    const { token, userId } = await registerAndLogin();
    const off = await api(
      'PUT',
      '/user/settings',
      { achievementEnabled: false },
      token,
    );
    expect(off.status).toBe(200);

    await playKeepEnd(token, 1, true); // 首局 → first_match 解锁（后台照常累计）
    await eventually(async () => isUnlocked(token, 'first_match'));

    const duringOff = await achMap(token);
    expect(duringOff.enabled).toBe(false); // off 仍返回记录（防一次性成就永久错过）
    expect(duringOff.byCode.get('first_match')).toMatchObject({ unlocked: true, claimed: false });

    const on = await api('PUT', '/user/settings', { achievementEnabled: true }, token);
    expect(on.status).toBe(200);
    const visible = await achMap(token);
    expect(visible.enabled).toBe(true);
    expect(visible.byCode.get('first_match')?.unlocked).toBe(true);

    const before = await balance(userId);
    const claim = await api('POST', '/achievements/first_match/claim', {}, token);
    expect(claim.status).toBe(201);
    expect(claim.data.alreadyClaimed).toBe(false);
    expect(claim.data.rewardFen).toBe(15000); // 150 元 → 分
    await assertNewFlowInvariant(userId, '成就', before);

    // 重复 claim 幂等（任务 E：回放金额/余额取流水行）
    const afterClaim = await balance(userId);
    const dup = await api('POST', '/achievements/first_match/claim', {}, token);
    expect(dup.status).toBe(201);
    expect(dup.data.alreadyClaimed).toBe(true);
    expect(dup.data.rewardFen).toBe(15000);
    expect(dup.data.balanceFen).toBe(afterClaim);
    expect((await flowsOf(userId)).filter((f) => f.type === '成就')).toHaveLength(1);
    expect(await balance(userId)).toBe(afterClaim);
  });
});

describe('成就领取幂等回放（任务 E：金额/余额以流水为准；附录 A：成就 6 项一次性解锁——重复领取幂等，不重复发放）', () => {
  it('任务 claim 回放：rewardFen/balanceFen 与既有流水行一致', async () => {
    const { token, userId } = await registerAndLogin();
    await quickSettle(token, 1);
    await eventually(async () => {
      const res = await api('GET', '/tasks', undefined, token);
      return res.data.tasks.find((t: { code: string }) => t.code === 'atm_1')?.claimable === true;
    });
    const first = await api('POST', '/tasks/atm_1/claim', {}, token);
    expect(first.status).toBe(201);
    const flow = (await flowsOf(userId)).find((f) => f.type === '任务')!;
    const replay = await api('POST', '/tasks/atm_1/claim', {}, token);
    expect(replay.status).toBe(201);
    expect(replay.data.alreadyClaimed).toBe(true);
    expect(replay.data.rewardFen).toBe(flow.amount);
    expect(replay.data.balanceFen).toBe(flow.balance_after);
  });
});

describe('win_streak_guard 真实结算 e2e（M8-fix1【文档外补充：2026-10-03 人工决策落地】）', () => {
  const injectGuard = (enabled: boolean): void => {
    const base = getEconomyExt();
    setEconomyExtCacheForTest({
      ...base,
      winStreakGuard: enabled
        ? {
            enabled: true,
            // M8-fix2【文档外补充：2026-10-03 人工决策落地】
            // trigger=1 分为测试内自定参数，偏离建议值 500 元，以使任意盈利局必触发冻结。
            triggerProfitFen: 1,
            keepRatioBp: 5000,
            capFen: 1000,
            resetHours: 24,
          }
        : {
            enabled: false,
            triggerProfitFen: null,
            keepRatioBp: null,
            capFen: null,
            resetHours: null,
          },
    });
  };

  afterEach(() => {
    setEconomyExtCacheForTest(null);
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('真实盈利结算先触发冻结，下一盈利局按比例及封顶截断', async () => {
    injectGuard(true);
    const { token, userId } = await registerAndLogin();

    const first = await playKeepEnd(token, 1, true);

    // M8-fix2【文档外补充：2026-10-03 人工决策落地】
    // 开启态下触发冻结的当局仍按结算前的未冻结状态全额入账。
    expect(first.settlement.prizeFen).toBe(388800);
    const firstFlows = await flowsOf(userId);
    const firstBonus = firstFlows.filter(
      (flow) => flow.type === '奖金' && flow.ref_id === String(first.sessionId),
    );
    expect(firstBonus).toHaveLength(1);
    expect(firstBonus[0].amount).toBe(388800);
    const firstTaxes = firstFlows.filter(
      (flow) => flow.type === '税' && flow.ref_id === String(first.sessionId),
    );
    expect(firstTaxes).toHaveLength(1);
    expect(firstTaxes[0].amount).toBe(-first.settlement.taxFen);

    const triggered = await gameStateRow(userId);
    expect(triggered.guard_frozen).toBe(1);
    expect(triggered.guard_triggered_at).toBe(fakeClock.now());
    expect(triggered.win_streak).toBe(1);

    const second = await playKeepEnd(token, 1, true, false);
    expect(second.settlement.profitFen).toBe(1000);
    expect(second.settlement.prizeFen).toBe(39800);
    const afterTruncated = await gameStateRow(userId);
    expect(afterTruncated.guard_frozen).toBe(1);
    expect(afterTruncated.win_streak).toBe(2);
    expect(afterTruncated.total_settled_games).toBe(2);

    const secondFlows = await flowsOf(userId);
    const bonus = secondFlows.filter(
      (flow) => flow.type === '奖金' && flow.ref_id === String(second.sessionId),
    );
    expect(bonus).toHaveLength(1);
    expect(bonus[0].amount).toBe(39800);
    expect(
      secondFlows.some(
        (flow) => flow.ref_id === String(second.sessionId) && flow.amount > 39800,
      ),
    ).toBe(false);

    // M8-fix2【文档外补充：2026-10-03 人工决策落地】
    // 截断后盈利仅 1000 分，低于 1000 元起征点，不应产生税流水。
    expect(
      secondFlows.filter(
        (flow) => flow.type === '税' && flow.ref_id === String(second.sessionId),
      ),
    ).toHaveLength(0);
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('重复提交已结算动作不重复更新计数器、余额或流水', async () => {
    injectGuard(true);
    const { token, userId } = await registerAndLogin();
    const settled = await playKeepEnd(token, 1, true);
    const stateBefore = await gameStateRow(userId);
    const balanceBefore = await balance(userId);
    const flowsBefore = await flowsOf(userId);

    const replay = await api(
      'POST',
      `/match/${settled.sessionId}/swap`,
      { swap: false },
      token,
    );
    expect(replay.status).toBe(409);
    expect(await gameStateRow(userId)).toEqual(stateBefore);
    expect(await balance(userId)).toBe(balanceBefore);
    expect(await flowsOf(userId)).toEqual(flowsBefore);
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('数据库中已有冻结状态会被下一次真实结算读取并继续生效', async () => {
    injectGuard(true);
    const { token, userId } = await registerAndLogin();
    await dataSource.query(
      `INSERT INTO user_game_state
         (user_id, win_streak, streak_profit_fen, guard_frozen,
          guard_triggered_at, total_settled_games)
       VALUES (?, 3, 9000, 1, ?, 3)`,
      [userId, fakeClock.now()],
    );

    const settled = await playKeepEnd(token, 1, true, false);
    expect(settled.settlement.profitFen).toBe(1000);
    expect(settled.settlement.prizeFen).toBe(39800);
    expect(await gameStateRow(userId)).toMatchObject({
      win_streak: 4,
      streak_profit_fen: 10000,
      guard_frozen: 1,
      guard_triggered_at: fakeClock.now(),
      total_settled_games: 4,
    });
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('功能关闭且未冻结时沿用原结算金额，不发生截断', async () => {
    injectGuard(false);
    const { token, userId } = await registerAndLogin();

    const settled = await playKeepEnd(token, 1, true);
    expect(settled.settlement.profitFen).toBeGreaterThan(1000);
    expect(settled.settlement.prizeFen).toBe(388800);
    expect(await gameStateRow(userId)).toMatchObject({
      win_streak: 1,
      guard_frozen: 0,
      guard_triggered_at: null,
      total_settled_games: 1,
    });

    const bonus = (await flowsOf(userId)).filter(
      (flow) => flow.type === '奖金' && flow.ref_id === String(settled.sessionId),
    );
    expect(bonus).toHaveLength(1);
    expect(bonus[0].amount).toBe(388800);
  });
});
