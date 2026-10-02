/**
 * M2 对局集成测试（supertest 风格的 fetch + 假时钟 + 真实 SQLite 测试库）：
 * 1. 完整一局三种结局（Deal 成交 / 还价被接受 / 拒绝到底换牌），验证余额、税、offers、状态机；
 * 2. 断线重连 GET state 恢复 + 防泄牌断言（不含 seed/rngState/未翻牌位金额）；
 * 3. 超时自动结算（假时钟推进 5 分钟），终局固定保留底牌；
 * 4. start 与结算重复请求幂等（同幂等键重放 + 并发双击，余额只变一次）；
 * 5. 余额不足 / 越级档位 / 已有进行中对局 → 拒绝；
 * 6. 同 seed 重放引擎事件流与 offers 表行一致（k/draw/probability 全留痕）；
 * 7. 服务重启（销毁重建 Nest 应用）后进行中对局可恢复续玩，deadline 已过者被立即托管；
 * 8. WebSocket（6.4）：JWT 握手鉴权、heartbeat、offer_ready/flip_result/timeout_warning/match_settled。
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { io, type Socket } from 'socket.io-client';
import { DataSource } from 'typeorm';
import {
  calcTaxFen,
  createGame,
  GameStatus,
  parseEconomyConfig,
  type GameEvent,
  type OfferMadeEvent,
} from '../src/game-engine';
import { REPO_ROOT } from '../src/config/paths';

jest.setTimeout(120000);

// 独立临时库（必须在加载 AppModule 前设置：data-source 在模块评估时读 env）
const tmpDir = mkdtempSync(join(tmpdir(), 'dond-match-'));
process.env.DATABASE_URL = join(tmpDir, 'test.db');

/* eslint-disable @typescript-eslint/no-var-requires */
const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
const { configureApp } = require('../src/main') as typeof import('../src/main');
const { CLOCK } = require('../src/match/clock') as typeof import('../src/match/clock');
const { GameSessionService } =
  require('../src/match/game-session.service') as typeof import('../src/match/game-session.service');
/* eslint-enable @typescript-eslint/no-var-requires */

/** 假时钟（任务书 §8：注入时钟推进 5 分钟） */
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

const tiersRaw = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'tiers.json'), 'utf8'));
const economyRaw = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'economy.json'), 'utf8'));
const eco = parseEconomyConfig(economyRaw);

/** 与 service 内 TIMEOUT_MS 一致（3.6.8 钦定 5 分钟） */
const TIMEOUT_MS = 5 * 60 * 1000;
const INITIAL_FUNDS_FEN = 1000000; // config/economy.json initial_funds=10000 元

const apps: INestApplication[] = [];
let app: INestApplication;
let dataSource: DataSource;
let baseUrl: string;
let sessionService: InstanceType<typeof GameSessionService>;

async function createApp(): Promise<void> {
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
  apps.push(app);
}

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
    username: uniq('m'),
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

async function flowsOf(userId: number): Promise<
  { amount: number; balance_after: number; type: string; ref_id: string | null; idem_key: string | null }[]
> {
  return dataSource.query(
    'SELECT amount, balance_after, type, ref_id, idem_key FROM fund_flows WHERE user_id = ? ORDER BY id',
    [userId],
  );
}

async function offersOf(sessionId: number): Promise<
  {
    id: number;
    round: number | null;
    offer_amount: number;
    result: string | null;
    counter_amount: number | null;
    k: number | null;
    ev_fen: number | null;
    counter_draw: number | null;
    counter_probability: number | null;
  }[]
> {
  return dataSource.query('SELECT * FROM offers WHERE session_id = ? ORDER BY id', [sessionId]);
}

async function sessionRow(sessionId: number): Promise<Record<string, any>> {
  const rows = await dataSource.query('SELECT * FROM game_sessions WHERE id = ?', [sessionId]);
  return rows[0]; // eslint-disable-line @typescript-eslint/no-unsafe-return
}

/**
 * 逐张 POST /flip {position} 翻完当前轮（M3：整轮一键翻牌已改为逐张点击；
 * 按牌位升序跳过底牌/已翻位），返回配额耗尽转入报价后的最新 state。
 */
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

/** 连接 /game 命名空间（transports=websocket 避免轮询干扰） */
function connectWs(token?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}/game`, {
      path: '/ws/socket.io',
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

beforeAll(async () => {
  await createApp();
});

afterAll(async () => {
  for (const a of apps) {
    await a.close().catch(() => undefined);
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('完整一局：Deal 成交（验收 1）', () => {
  it('扣费/翻牌/报价/成交/结算全链路：余额、税、offers、状态机正确', async () => {
    const { token, userId } = await registerAndLogin();

    const start = await api('POST', '/match/start', { tier: 1, clientKey: 'deal-1' }, token);
    expect(start.status).toBe(201);
    const sessionId = start.data.sessionId as number;
    expect(start.data.state.engineStatus).toBe('PICK_OWN_CARD');
    expect(start.data.state.entryFeeFen).toBe(38800);
    expect(await balance(userId)).toBe(INITIAL_FUNDS_FEN - 38800);

    // 请求体缺 position → 400（文档外补充校验）；未选底牌带 position → 409（状态机校验）
    expect((await api('POST', `/match/${sessionId}/flip`, {}, token)).status).toBe(400);
    const early = await api('POST', `/match/${sessionId}/flip`, { position: 0 }, token);
    expect(early.status).toBe(409);

    const pick = await api('POST', `/match/${sessionId}/pick`, { index: 3 }, token);
    expect(pick.status).toBe(201);
    expect(pick.data.state.engineStatus).toBe('FLIP_ROUND_N');
    expect(pick.data.state.flipQuota).toBe(6);
    expect(pick.data.state.ownCardPosition).toBe(3);

    // 底牌位置不可翻 → 400（引擎 BAD_FLIP_POSITION）
    expect((await api('POST', `/match/${sessionId}/flip`, { position: 3 }, token)).status).toBe(400);

    // 逐张点击翻牌（M3）：中途配额递减、停留翻牌态；第 6 张后配额耗尽转入报价
    let flipState = pick.data.state;
    let flippedCount = 0;
    for (let p = 0; p < 26; p++) {
      if (flipState.engineStatus !== 'FLIP_ROUND_N') break;
      if (p === 3) continue; // 底牌不可翻
      const res = await api('POST', `/match/${sessionId}/flip`, { position: p }, token);
      expect(res.status).toBe(201);
      flippedCount += 1;
      flipState = res.data.state;
      if (flippedCount < 6) {
        expect(flipState.engineStatus).toBe('FLIP_ROUND_N');
        expect(flipState.flipQuota).toBe(6 - flippedCount);
        expect(flipState.currentOffer).toBeNull(); // 配额耗尽前不生成报价
      }
    }
    expect(flipState.flippedCards).toHaveLength(6);
    expect(flipState.engineStatus).toBe('BANKER_OFFER');
    expect(flipState.flipQuota).toBe(0);
    expect(flipState.round).toBe(1);
    expect(flipState.currentOffer).not.toBeNull();

    // 幂等：重复提交同一已翻位置直接返回当前 state，不重复淘汰
    const dupFlip = await api(
      'POST',
      `/match/${sessionId}/flip`,
      { position: flipState.flippedCards[0].position as number },
      token,
    );
    expect(dupFlip.status).toBe(201);
    expect(dupFlip.data.state.flippedCards).toHaveLength(6);
    expect(dupFlip.data.state.engineStatus).toBe('BANKER_OFFER');

    // GET offer 只读：两次返回一致（不消耗 RNG）
    const o1 = await api('GET', `/match/${sessionId}/offer`, undefined, token);
    const o2 = await api('GET', `/match/${sessionId}/offer`, undefined, token);
    expect(o1.status).toBe(200);
    expect(o1.data.offer.offerFen).toBe(o2.data.offer.offerFen);
    const offerFen = o1.data.offer.offerFen as number;
    expect(o1.data.offer).toEqual({
      round: 1,
      isFinal: false,
      phase: 'early',
      offerFen,
    });

    const deal = await api('POST', `/match/${sessionId}/deal`, {}, token);
    expect(deal.status).toBe(201);
    const st = deal.data.state;
    expect(st.status).toBe('成交');
    expect(st.engineStatus).toBe('SETTLE');
    expect(st.settlement.reason).toBe('deal');
    expect(st.settlement.prizeFen).toBe(offerFen);
    const expectedTax = calcTaxFen(offerFen - 38800, eco.tax).taxFen;
    expect(st.settlement.taxFen).toBe(expectedTax);
    const expectedBalance = INITIAL_FUNDS_FEN - 38800 + offerFen - expectedTax;
    expect(await balance(userId)).toBe(expectedBalance);
    expect(st.settledBalanceFen).toBe(expectedBalance);
    expect(st.netProfitFen).toBe(offerFen - expectedTax - 38800);

    // fund_flows：初始赠送/入场/奖金（+税，若 tax>0）
    const flows = await flowsOf(userId);
    expect(flows.map((f) => f.type)).toEqual(
      expectedTax > 0
        ? ['初始赠送', '入场', '奖金', '税']
        : ['初始赠送', '入场', '奖金'],
    );
    expect(flows[1]).toMatchObject({
      amount: -38800,
      ref_id: String(sessionId),
      idem_key: `match:${userId}:start:deal-1`,
    });
    expect(flows[2]).toMatchObject({
      amount: offerFen,
      idem_key: `match:${sessionId}:bonus`,
    });
    if (expectedTax > 0) {
      expect(flows[3]).toMatchObject({ amount: -expectedTax, idem_key: `match:${sessionId}:tax` });
    }

    // offers 表：一行，成交，k/ev 留痕
    const offers = await offersOf(sessionId);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ round: 1, offer_amount: offerFen, result: '成交' });
    expect(typeof offers[0].k).toBe('number');
    expect(typeof offers[0].ev_fen).toBe('number');

    // game_sessions 结算字段
    const row = await sessionRow(sessionId);
    expect(row.status).toBe('成交');
    expect(row.final_bonus).toBe(offerFen);
    expect(row.tax).toBe(expectedTax);
    expect(row.net_profit).toBe(offerFen - expectedTax - 38800);
    expect(row.settled_balance).toBe(expectedBalance);
    expect(row.finished_at).not.toBeNull();

    // 结算后重复 deal → 409，余额不变（幂等）
    const dup = await api('POST', `/match/${sessionId}/deal`, {}, token);
    expect(dup.status).toBe(409);
    expect(await balance(userId)).toBe(expectedBalance);
    expect(await offersOf(sessionId)).toHaveLength(1);
  });
});

describe('完整一局：还价被接受（验收 1/6，覆盖税 > 0 路径）', () => {
  it('还价 ≤ 0.85EV 必接受，按还价金额成交计税；同 seed 重放与 offers 行一致', async () => {
    const { token, userId } = await registerAndLogin();
    // tier=2（入门档 entry 200000 分）：EV 约 38 万分，还价 0.84EV 必接受且必产生税
    const start = await api('POST', '/match/start', { tier: 2, clientKey: 'counter-1' }, token);
    expect(start.status).toBe(201);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 5 }, token);
    await flipWholeRound(sessionId, token);

    // 白盒：从 game_cards 读未淘汰金额算 EV（与引擎同值）
    const remaining = (await dataSource.query(
      "SELECT amount FROM game_cards WHERE session_id = ? AND state != '已淘汰'",
      [sessionId],
    )) as { amount: number }[];
    expect(remaining).toHaveLength(20);
    const ev = remaining.reduce((a, r) => a + r.amount, 0) / remaining.length;
    const minRemain = Math.min(...remaining.map((r) => r.amount));
    const counter = Math.max(minRemain, Math.floor(ev * 0.84));

    const res = await api('POST', `/match/${sessionId}/counter`, { counter }, token);
    expect(res.status).toBe(201);
    const st = res.data.state;
    expect(st.status).toBe('成交');
    expect(st.settlement.reason).toBe('counter');
    expect(st.settlement.prizeFen).toBe(counter);
    const expectedTax = calcTaxFen(counter - 200000, eco.tax).taxFen;
    expect(st.settlement.taxFen).toBe(expectedTax);
    expect(await balance(userId)).toBe(INITIAL_FUNDS_FEN - 200000 + counter - expectedTax);

    const flows = await flowsOf(userId);
    expect(flows.map((f) => f.type)).toEqual(
      expectedTax > 0
        ? ['初始赠送', '入场', '奖金', '税']
        : ['初始赠送', '入场', '奖金'],
    );
    if (expectedTax > 0) expect(flows[3].amount).toBe(-expectedTax);

    const offers = await offersOf(sessionId);
    expect(offers).toHaveLength(1);
    expect(offers[0].result).toBe('还价接受');
    expect(offers[0].counter_amount).toBe(counter);
    expect(offers[0].counter_probability).toBe(1); // 必接受分支
    expect(offers[0].counter_draw).toBeNull();

    // 同 seed 重放：引擎事件流应与 offers 行一致（七章.3 可审计）
    const snap = JSON.parse((await sessionRow(sessionId)).state_snapshot as string) as {
      tierId: string;
      seed: string;
    };
    const engine = createGame({
      tierId: snap.tierId,
      seed: snap.seed,
      tiersConfig: tiersRaw,
      economyConfig: economyRaw,
    });
    engine.pickOwnCard(5);
    const flipEvents = engine.flipCurrentRound();
    const counterEvents = engine.respondOffer({ counter });
    const offerMade = flipEvents.find(
      (e): e is OfferMadeEvent => e.type === 'offer_made',
    ) as OfferMadeEvent;
    const counterMade = counterEvents.find(
      (e): e is Extract<GameEvent, { type: 'counter_made' }> => e.type === 'counter_made',
    );
    expect(offers[0].offer_amount).toBe(offerMade.offerFen);
    expect(offers[0].k).toBe(offerMade.k);
    expect(offers[0].ev_fen).toBe(offerMade.evFen);
    expect(counterMade).toMatchObject({
      counterFen: counter,
      accepted: true,
      probability: 1,
      draw: null,
    });
    expect(offers[0].counter_probability).toBe(counterMade!.probability);
    expect(offers[0].counter_draw).toBe(counterMade!.draw);
  });

  it('非法还价直接驳回且不计入本轮还价次数（3.6.5）', async () => {
    const { token } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 1 }, token);
    await flipWholeRound(sessionId, token);

    // 还价低于剩余最低面额 → 400，不消耗还价机会
    const bad = await api('POST', `/match/${sessionId}/counter`, { counter: 0 }, token);
    expect(bad.status).toBe(400);
    let st = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
    expect(st.counterUsed).toBe(false);

    // 还价高于档位上限 → 400，仍不消耗
    const bad2 = await api('POST', `/match/${sessionId}/counter`, { counter: 388800 + 1 }, token);
    expect(bad2.status).toBe(400);
    st = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
    expect(st.counterUsed).toBe(false);

    // 非整数 → 400（DTO 校验）
    const bad3 = await api('POST', `/match/${sessionId}/counter`, { counter: 100.5 }, token);
    expect(bad3.status).toBe(400);
  });
});

describe('完整一局：拒绝到底换牌（验收 1/6）', () => {
  it('9 轮报价 + 终局报价全部拒绝 → 换牌决策 → 保留底牌结算（终局）；offers 与同 seed 重放一致', async () => {
    const { token, userId } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1, clientKey: 'swap-1' }, token);
    const sessionId = start.data.sessionId as number;

    // 白盒选最大面额为底牌 → 终局保留底牌必出税（确定性覆盖税 > 0 结算路径）
    const pool = (await dataSource.query(
      'SELECT position, amount FROM game_cards WHERE session_id = ?',
      [sessionId],
    )) as { position: number; amount: number }[];
    const ownPos = pool.reduce((a, b) => (b.amount > a.amount ? b : a)).position;
    const maxAmount = Math.max(...pool.map((r) => r.amount));
    expect(calcTaxFen(maxAmount - 38800, eco.tax).taxFen).toBeGreaterThan(0);

    let state = (await api('POST', `/match/${sessionId}/pick`, { index: ownPos }, token)).data.state;
    let guard = 0;
    while (state.engineStatus !== 'SETTLE') {
      guard += 1;
      expect(guard).toBeLessThan(50);
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
    expect(state.status).toBe('终局');
    expect(state.settlement.reason).toBe('keep');
    expect(state.round).toBe(9);
    expect(state.flippedCards).toHaveLength(24);
    expect(state.remainingCount).toBe(2);

    // 保留底牌 → 税前奖金 = 底牌金额（本测试选最大面额，税必 > 0）
    const own = (await dataSource.query(
      "SELECT amount FROM game_cards WHERE session_id = ? AND state = '底牌'",
      [sessionId],
    )) as { amount: number }[];
    expect(state.settlement.prizeFen).toBe(own[0].amount);
    expect(own[0].amount).toBe(maxAmount);
    const expectedTax = calcTaxFen(own[0].amount - 38800, eco.tax).taxFen;
    expect(expectedTax).toBeGreaterThan(0);
    expect(state.settlement.taxFen).toBe(expectedTax);
    expect(await balance(userId)).toBe(
      INITIAL_FUNDS_FEN - 38800 + own[0].amount - expectedTax,
    );
    const flows = await flowsOf(userId);
    expect(flows.map((f) => f.type)).toEqual(['初始赠送', '入场', '奖金', '税']);
    expect(flows[2].amount).toBe(own[0].amount);
    expect(flows[3].amount).toBe(-expectedTax);

    // offers 表：10 行（第 1–9 轮 + 终局 NULL 轮），全部「拒绝」
    const offers = await offersOf(sessionId);
    expect(offers).toHaveLength(10);
    for (let i = 0; i < 9; i++) expect(offers[i].round).toBe(i + 1);
    expect(offers[9].round).toBeNull();
    for (const o of offers) expect(o.result).toBe('拒绝');

    // 同 seed 重放：10 条 offer_made 事件与 offers 行逐字段一致
    const snap = JSON.parse((await sessionRow(sessionId)).state_snapshot as string) as {
      tierId: string;
      seed: string;
    };
    const engine = createGame({
      tierId: snap.tierId,
      seed: snap.seed,
      tiersConfig: tiersRaw,
      economyConfig: economyRaw,
    });
    engine.pickOwnCard(ownPos);
    const replayOffers: OfferMadeEvent[] = [];
    let s = engine.getState();
    guard = 0;
    while (s.status !== GameStatus.Settle) {
      guard += 1;
      expect(guard).toBeLessThan(50);
      let events: GameEvent[] = [];
      if (s.status === GameStatus.FlipRound) events = engine.flipCurrentRound();
      else if (s.status === GameStatus.BankerOffer || s.status === GameStatus.FinalOffer)
        events = engine.respondOffer('noDeal');
      else if (s.status === GameStatus.SwapDecision) events = engine.decideSwap(false);
      else throw new Error(`意外状态 ${String(s.status)}`);
      replayOffers.push(...events.filter((e): e is OfferMadeEvent => e.type === 'offer_made'));
      s = engine.getState();
    }
    expect(replayOffers).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(offers[i].offer_amount).toBe(replayOffers[i].offerFen);
      expect(offers[i].k).toBe(replayOffers[i].k);
      expect(offers[i].ev_fen).toBe(replayOffers[i].evFen);
      expect(offers[i].round).toBe(replayOffers[i].round);
    }
  });
});

describe('断线重连与防泄牌（验收 2）', () => {
  it('GET state 恢复全部玩家可见状态，且不含 seed/rngState/未翻牌位金额', async () => {
    const { token, userId } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 3 }, token);
    await flipWholeRound(sessionId, token);

    // 模拟重连：全新请求 GET state
    const res = await api('GET', `/match/${sessionId}/state`, undefined, token);
    expect(res.status).toBe(200);
    const st = res.data;
    expect(st.engineStatus).toBe('BANKER_OFFER');
    expect(st.round).toBe(1);
    expect(st.ownCardPosition).toBe(3);
    expect(st.flippedCards).toHaveLength(6);
    expect(st.remainingCount).toBe(20);
    expect(st.currentOffer.offerFen).toBeGreaterThan(0);
    expect(st.counterUsed).toBe(false);
    expect(st.timeoutDeadline).toBeTruthy();

    // 防泄牌回归：响应中禁止出现机密字段名
    const raw = JSON.stringify(st);
    for (const forbidden of ['seed', 'rngState', 'stateSnapshot', 'state_snapshot', 'poolFen']) {
      expect(raw.includes(`"${forbidden}"`)).toBe(false);
    }

    // 已翻牌位与金额 == DB 已淘汰集合（位置对应关系正确且无多泄）
    const eliminated = (await dataSource.query(
      "SELECT position, amount FROM game_cards WHERE session_id = ? AND state = '已淘汰' ORDER BY position",
      [sessionId],
    )) as { position: number; amount: number }[];
    const viewCards = [...st.flippedCards].sort(
      (a: { position: number }, b: { position: number }) => a.position - b.position,
    );
    expect(viewCards).toEqual(
      eliminated.map((c) => ({ position: c.position, amountFen: c.amount })),
    );

    // 底牌与未翻公共牌金额绝不出现在玩家视图（逐一比对数值）
    const hidden = (await dataSource.query(
      "SELECT amount FROM game_cards WHERE session_id = ? AND state != '已淘汰'",
      [sessionId],
    )) as { amount: number }[];
    const revealedNumbers = new Set<number>(st.flippedCards.map((c: { amountFen: number }) => c.amountFen));
    for (const h of hidden) {
      expect(revealedNumbers.has(h.amount)).toBe(false);
    }

    // 他人会话不可见（404）
    const other = await registerAndLogin();
    const forbidden = await api('GET', `/match/${sessionId}/state`, undefined, other.token);
    expect(forbidden.status).toBe(404);
    expect(userId).not.toBe(other.userId);
  });

  it('面额清单：多重集合升序 + 淘汰划线；开关关闭返回关闭态（3.6.2/3.7）', async () => {
    const { token, userId } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 2 }, token);
    await flipWholeRound(sessionId, token);

    const res = await api('GET', `/match/${sessionId}/amount-list`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.data.enabled).toBe(true);
    const amounts = res.data.amounts as { amountFen: number; eliminated: boolean }[];
    expect(amounts).toHaveLength(26);
    // 升序
    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i].amountFen).toBeGreaterThanOrEqual(amounts[i - 1].amountFen);
    }
    // 不携带位置对应关系
    expect(JSON.stringify(amounts).includes('"position"')).toBe(false);
    // 多重集合与 DB 卡池一致
    const pool = (await dataSource.query(
      'SELECT amount FROM game_cards WHERE session_id = ? ORDER BY amount',
      [sessionId],
    )) as { amount: number }[];
    expect(amounts.map((a) => a.amountFen)).toEqual(pool.map((r) => r.amount));
    // 恰好 6 张已淘汰（第 1 轮翻 6 张）
    expect(amounts.filter((a) => a.eliminated)).toHaveLength(6);

    // 关闭开关 → 关闭态
    await dataSource.query('UPDATE user_settings SET amount_list_enabled = 0 WHERE user_id = ?', [
      userId,
    ]);
    const off = await api('GET', `/match/${sessionId}/amount-list`, undefined, token);
    expect(off.data).toEqual({ enabled: false, amounts: [] });
  });
});

describe('超时托管（验收 3）', () => {
  it('假时钟推进 5 分钟 → 自动 No Deal 走完全程，终局固定保留底牌，offers 全超时', async () => {
    const { token, userId } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 9 }, token);

    const before = await balance(userId);
    fakeClock.advance(TIMEOUT_MS + 1000);
    await sessionService.scanTimeouts();

    const res = await api('GET', `/match/${sessionId}/state`, undefined, token);
    expect(res.data.status).toBe('超时结算');
    expect(res.data.engineStatus).toBe('SETTLE');
    expect(res.data.settlement.reason).toBe('keep'); // 终局固定保留底牌
    expect(res.data.flippedCards).toHaveLength(24);

    // 奖金 = 底牌金额（托管 pick 已由玩家完成，own=9 号位）
    const own = (await dataSource.query(
      "SELECT amount FROM game_cards WHERE session_id = ? AND state = '底牌'",
      [sessionId],
    )) as { amount: number }[];
    expect(res.data.settlement.prizeFen).toBe(own[0].amount);
    const tax = calcTaxFen(own[0].amount - 38800, eco.tax).taxFen;
    expect(await balance(userId)).toBe(before + own[0].amount - tax);

    const offers = await offersOf(sessionId);
    expect(offers).toHaveLength(10);
    for (const o of offers) expect(o.result).toBe('超时');

    // 事件流打 timeout=true（快照事件审计）
    const snap = JSON.parse((await sessionRow(sessionId)).state_snapshot as string) as {
      events: { type: string; timeout: boolean }[];
    };
    const settled = snap.events.find((e) => e.type === 'settled');
    expect(settled?.timeout).toBe(true);
  });
});

describe('幂等与拒绝分支（验收 4/5）', () => {
  it('start 同幂等键并发双击 + 顺序重放：同一会话，余额只扣一次', async () => {
    const { token, userId } = await registerAndLogin();
    const [r1, r2] = await Promise.all([
      api('POST', '/match/start', { tier: 1, clientKey: 'dup-1' }, token),
      api('POST', '/match/start', { tier: 1, clientKey: 'dup-1' }, token),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.data.sessionId).toBe(r2.data.sessionId);
    expect(await balance(userId)).toBe(INITIAL_FUNDS_FEN - 38800);

    // 顺序重放（含已结算后重放仍返回同一会话）
    const r3 = await api('POST', '/match/start', { tier: 1, clientKey: 'dup-1' }, token);
    expect(r3.data.sessionId).toBe(r1.data.sessionId);
    const flows = await flowsOf(userId);
    expect(flows.filter((f) => f.type === '入场')).toHaveLength(1);
    expect((await dataSource.query('SELECT COUNT(*) c FROM game_sessions WHERE user_id = ?', [userId]))[0].c).toBe(1);
  });

  it('结算并发双击：余额只变一次、offers 不重复行', async () => {
    const { token, userId } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 4 }, token);
    const flipState = await flipWholeRound(sessionId, token);
    const offerFen = flipState.currentOffer.offerFen as number;

    const [d1, d2] = await Promise.all([
      api('POST', `/match/${sessionId}/deal`, {}, token),
      api('POST', `/match/${sessionId}/deal`, {}, token),
    ]);
    expect([d1.status, d2.status].sort()).toEqual([201, 409]);
    const expectedTax = calcTaxFen(offerFen - 38800, eco.tax).taxFen;
    expect(await balance(userId)).toBe(INITIAL_FUNDS_FEN - 38800 + offerFen - expectedTax);
    expect(await offersOf(sessionId)).toHaveLength(1);
    const flows = await flowsOf(userId);
    expect(flows.filter((f) => f.type === '奖金')).toHaveLength(1);
  });

  it('余额不足（含取款机档）/ 越级 / 非法档位 → 拒绝', async () => {
    const { token, userId } = await registerAndLogin();
    // 非法档位
    expect((await api('POST', '/match/start', { tier: 0 }, token)).status).toBe(400);
    expect((await api('POST', '/match/start', { tier: 6 }, token)).status).toBe(400);
    // 越级：余额 100 万分 < 标准档 200 万入场费
    expect((await api('POST', '/match/start', { tier: 3 }, token)).status).toBe(400);
    expect((await api('POST', '/match/start', { tier: 5 }, token)).status).toBe(400);
    // 余额不足（含取款机档）：余额压到 100 分后 tier=1 也拒绝
    await dataSource.query('UPDATE user_wallets SET balance = 100 WHERE user_id = ?', [userId]);
    const poor = await api('POST', '/match/start', { tier: 1 }, token);
    expect(poor.status).toBe(400);
    expect(String(poor.data.message)).toContain('余额不足');
    expect(await balance(userId)).toBe(100);
  });

  it('已有进行中对局 → 409 并返回该会话 id（文档外补充，待人工确认）', async () => {
    const { token } = await registerAndLogin();
    const first = await api('POST', '/match/start', { tier: 1 }, token);
    expect(first.status).toBe(201);
    const again = await api('POST', '/match/start', { tier: 1 }, token);
    expect(again.status).toBe(409);
    expect(again.data.sessionId).toBe(first.data.sessionId);
    // 未携带幂等键的并发双击同样被单一活跃约束拒绝
    const [c1, c2] = await Promise.all([
      api('POST', '/match/start', { tier: 1 }, token),
      api('POST', '/match/start', { tier: 1 }, token),
    ]);
    expect([c1.status, c2.status].sort()).toEqual([409, 409]);
  });

  it('未登录访问对局接口 → 401', async () => {
    expect((await api('POST', '/match/start', { tier: 1 })).status).toBe(401);
    expect((await api('GET', '/match/1/state')).status).toBe(401);
  });
});

describe('WebSocket（6.4，验收 §7）', () => {
  it('JWT 握手鉴权：无 token 断开；heartbeat / offer_ready / flip_result / timeout_warning / match_settled', async () => {
    const { token, userId } = await registerAndLogin();

    // 无 token → 连接后被服务端断开（监听先挂载，防 disconnect 先于 connect 回调到达的竞态）
    const anon = io(`${baseUrl}/game`, {
      path: '/ws/socket.io',
      transports: ['websocket'],
      reconnection: false,
    });
    const anonDisconnected = new Promise<void>((resolve) =>
      anon.on('disconnect', () => resolve()),
    );
    await anonDisconnected;
    anon.close();

    const socket = await connectWs(token);
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;

    // heartbeat：重置内存超时计时
    const ack = (await socket.emitWithAck('heartbeat', { sessionId })) as { ok: boolean };
    expect(ack.ok).toBe(true);
    const badAck = (await socket.emitWithAck('heartbeat', { sessionId: 'x' })) as {
      ok: boolean;
    };
    expect(badAck.ok).toBe(false);

    await api('POST', `/match/${sessionId}/pick`, { index: 6 }, token);

    // 逐张翻牌（M3）：每张 flip_result（单元素数组）；配额耗尽瞬间 offer_ready
    const flipMsgs: Record<string, any>[] = [];
    socket.on('flip_result', (m: Record<string, any>) => flipMsgs.push(m));
    const offerP = new Promise<Record<string, any>>((resolve) =>
      socket.on('offer_ready', resolve),
    );
    await flipWholeRound(sessionId, token);
    const offerMsg = await offerP;
    expect(flipMsgs).toHaveLength(6);
    for (const m of flipMsgs) {
      expect(m.sessionId).toBe(sessionId);
      expect(m.round).toBe(1);
      expect(m.positions).toHaveLength(1);
      expect(m.amountsFen).toHaveLength(1);
    }
    expect(offerMsg.sessionId).toBe(sessionId);
    expect(Object.keys(offerMsg.offer).sort()).toEqual([
      'isFinal',
      'offerFen',
      'phase',
      'round',
    ]);

    // timeout_warning：推进到剩余 30 秒（心跳已重置过 deadline，基于当前假时钟）
    const warnings: Record<string, any>[] = [];
    const firstWarning = new Promise<Record<string, any>>((resolve) =>
      socket.once('timeout_warning', resolve),
    );
    socket.on('timeout_warning', (p) => warnings.push(p));
    fakeClock.advance(TIMEOUT_MS - 30 * 1000);
    await sessionService.scanTimeouts();
    const warning = await firstWarning; // WS 投递异步，以收到事件为准
    expect(warning.sessionId).toBe(sessionId);
    expect(warning.remainingSeconds).toBe(30);
    // 每会话去重只发一次（等待一个投递窗口确认无重发）
    fakeClock.advance(1000);
    await sessionService.scanTimeouts();
    await new Promise((r) => setTimeout(r, 300));
    expect(warnings).toHaveLength(1);

    // 推进到期 → match_settled（超时结算）
    const settledP = new Promise<Record<string, any>>((resolve) =>
      socket.on('match_settled', resolve),
    );
    fakeClock.advance(31 * 1000);
    await sessionService.scanTimeouts();
    const settledMsg = await settledP;
    expect(settledMsg.sessionId).toBe(sessionId);
    expect(settledMsg.status).toBe('超时结算');
    expect(settledMsg.timeout).toBe(true);
    expect(settledMsg.settlement.prizeFen).toBeGreaterThan(0);

    socket.close();
    // 对局已结算，余额已入账
    const st = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
    expect(st.status).toBe('超时结算');
    expect(userId).toBeGreaterThan(0);
  });
});

describe('注销 × 对局结算并发（事务互斥收口验收）', () => {
  it('并发 deleteAccount 与 deal ×10 轮：两者各自完整，无半态行残留', async () => {
    for (let round = 0; round < 10; round++) {
      const { token, userId } = await registerAndLogin();
      const start = await api('POST', '/match/start', { tier: 1 }, token);
      const sessionId = start.data.sessionId as number;
      await api('POST', `/match/${sessionId}/pick`, { index: 0 }, token);
      await flipWholeRound(sessionId, token);

      const [dealRes, delRes] = await Promise.all([
        api('POST', `/match/${sessionId}/deal`, {}, token),
        api('DELETE', '/user', { confirm: true }, token),
      ]);
      // 注销恒成功；deal 取决于全局互斥串行顺序：整体成功（201）或整体失败（404/409/500），
      // 但绝不允许半态（一切写事务经 runInTransaction，FK 约束兜底孤儿插入即整事务回滚）
      expect(delRes.status).toBe(200);
      expect([201, 404, 409, 500]).toContain(dealRes.status);

      // 终态：用户及全部关联行消失；offers/game_cards 无孤儿行的半删除状态
      const count = async (sql: string, param: number): Promise<number> =>
        Number(((await dataSource.query(sql, [param])) as { c: number }[])[0].c);
      expect(await count('SELECT COUNT(*) c FROM users WHERE id = ?', userId)).toBe(0);
      expect(await count('SELECT COUNT(*) c FROM game_sessions WHERE id = ?', sessionId)).toBe(0);
      expect(await count('SELECT COUNT(*) c FROM offers WHERE session_id = ?', sessionId)).toBe(0);
      expect(
        await count('SELECT COUNT(*) c FROM game_cards WHERE session_id = ?', sessionId),
      ).toBe(0);
      expect(await count('SELECT COUNT(*) c FROM fund_flows WHERE user_id = ?', userId)).toBe(0);
      expect(await count('SELECT COUNT(*) c FROM user_wallets WHERE user_id = ?', userId)).toBe(0);
    }
  });
});

describe('服务重启恢复（验收 7）', () => {
  it('销毁重建 Nest 应用：进行中对局可恢复续玩；deadline 已过者被立即托管', async () => {
    const { token } = await registerAndLogin();
    const start = await api('POST', '/match/start', { tier: 1 }, token);
    const sessionId = start.data.sessionId as number;
    await api('POST', `/match/${sessionId}/pick`, { index: 11 }, token);
    await flipWholeRound(sessionId, token);

    // 第一次重启：deadline 未过 → 恢复可续玩
    await app.close();
    await createApp();
    let st = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
    expect(st.engineStatus).toBe('BANKER_OFFER');
    expect(st.flippedCards).toHaveLength(6);
    // 续玩：拒绝报价进入下一轮
    const nd = await api('POST', `/match/${sessionId}/no-deal`, {}, token);
    expect(nd.status).toBe(201);
    expect(nd.data.state.engineStatus).toBe('FLIP_ROUND_N');
    expect(nd.data.state.round).toBe(2);

    // 关闭后推进假时钟超过 deadline（避免运行中应用定时器抢先托管），再重启
    await app.close();
    fakeClock.advance(TIMEOUT_MS + 1000);
    await createApp(); // onModuleInit 应立即托管（await 于 app.init 内）

    st = (await api('GET', `/match/${sessionId}/state`, undefined, token)).data;
    expect(st.status).toBe('超时结算');
    expect(st.engineStatus).toBe('SETTLE');
    const row = await sessionRow(sessionId);
    expect(row.status).toBe('超时结算');
    expect(row.finished_at).not.toBeNull();
  });
});

describe('大厅数据接口：GET /match/tiers（任务书 §0 文档外补充）+ GET /wallet（6.3）', () => {
  it('GET /match/tiers 输出五档名称/入场门槛/单局最高奖金（整数分），不含任何对局机密字段', async () => {
    const { token } = await registerAndLogin();
    const res = await api('GET', '/match/tiers', undefined, token);
    expect(res.status).toBe(200);
    expect(res.data).toEqual([
      { tier: 1, name: '取款机', entryFeeFen: 38800, maxPrizeFen: 388800 },
      { tier: 2, name: '入门档', entryFeeFen: 200000, maxPrizeFen: 1000000 },
      { tier: 3, name: '标准档', entryFeeFen: 2000000, maxPrizeFen: 10000000 },
      { tier: 4, name: '进阶档', entryFeeFen: 8000000, maxPrizeFen: 50000000 },
      { tier: 5, name: '最高档', entryFeeFen: 22500000, maxPrizeFen: 100000000 },
    ]);
    // 机密字段防泄漏：不允许出现卡池模板/权重/k 系数等
    expect(JSON.stringify(res.data)).not.toMatch(/amounts|weights|kRanges|seed|rng/i);

    const anon = await api('GET', '/match/tiers');
    expect(anon.status).toBe(401);
  });

  it('GET /wallet 返回当前余额与最近流水（整数分；初始赠送已入账）', async () => {
    const { token } = await registerAndLogin();
    const res = await api('GET', '/wallet', undefined, token);
    expect(res.status).toBe(200);
    expect(res.data.balanceFen).toBe(INITIAL_FUNDS_FEN);
    expect(res.data.flows).toHaveLength(1);
    expect(res.data.flows[0]).toMatchObject({
      amountFen: INITIAL_FUNDS_FEN,
      balanceAfterFen: INITIAL_FUNDS_FEN,
      type: '初始赠送',
    });

    const anon = await api('GET', '/wallet');
    expect(anon.status).toBe(401);
  });
});
