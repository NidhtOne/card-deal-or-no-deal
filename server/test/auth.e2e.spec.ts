import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { parseDbDate } from '../src/common/db-date';
import { configureApp } from '../src/main';

/**
 * 账号系统集成测试：真实 Nest 应用 + 真实 SQLite（临时文件），
 * 覆盖注册/并发 409/check-username/登录/锁定/记住我/Refresh 轮换/登出/密保重置/改密/注销。
 */

jest.setTimeout(120000);

// 测试库使用独立临时目录，避免污染开发库
const tmpDir = mkdtempSync(join(tmpdir(), 'dond-test-'));
process.env.DATABASE_URL = join(tmpDir, 'test.db');

let app: INestApplication;
let dataSource: DataSource;
let baseUrl: string;

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
/** 生成唯一用户名，总长控制在 16 位以内（用户名规则 4-16 位） */
function uniq(prefix: string): string {
  seq += 1;
  const suffix = `${Date.now().toString(36).slice(-4)}${seq.toString(36)}`;
  return `${prefix}${suffix}`.slice(0, 16);
}

const VALID_PW = 'abc12345';
const NEW_PW = 'xyz98765';

async function registerUser(username: string, extra: Record<string, unknown> = {}) {
  return api('POST', '/auth/register', {
    username,
    password: VALID_PW,
    confirmPassword: VALID_PW,
    securityQuestion: '我的小学名称？',
    securityAnswer: '阳光小学',
    ...extra,
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const server = await app.listen(0, '127.0.0.1');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('测试服务地址异常');
  baseUrl = `http://127.0.0.1:${address.port}`;
  dataSource = app.get(DataSource);
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('注册', () => {
  it('注册成功：自动登录返回双令牌，初始赠送流水正确', async () => {
    const username = uniq('reg');
    const res = await registerUser(username);
    expect(res.status).toBe(201);
    expect(res.data.accessToken).toBeTruthy();
    expect(res.data.refreshToken).toBeTruthy();
    expect(res.data.user.username).toBe(username);

    const userId = res.data.user.id as number;
    const wallet = await dataSource.query('SELECT balance FROM user_wallets WHERE user_id = ?', [
      userId,
    ]);
    expect(wallet).toHaveLength(1);
    expect(wallet[0].balance).toBe(1000000); // config/economy.json initial_funds=10000 元 → 分

    const flows = await dataSource.query(
      'SELECT amount, balance_after, type, idem_key FROM fund_flows WHERE user_id = ?',
      [userId],
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe(1000000);
    expect(flows[0].type).toBe('初始赠送');
    expect(flows[0].balance_after).toBe(wallet[0].balance);
    expect(flows[0].idem_key).toBe(`register:${userId}`);

    // 档案与设置行一并创建
    const profile = await dataSource.query('SELECT id FROM user_profiles WHERE user_id = ?', [
      userId,
    ]);
    const settings = await dataSource.query(
      'SELECT bgm_enabled, volume, sfx_enabled, sfx_volume, amount_list_enabled, risk_popup_enabled, achievement_enabled FROM user_settings WHERE user_id = ?',
      [userId],
    );
    expect(profile).toHaveLength(1);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      bgm_enabled: 1,
      volume: 60,
      sfx_enabled: 1,
      sfx_volume: 80,
      amount_list_enabled: 1,
      risk_popup_enabled: 1,
      achievement_enabled: 1,
    });
  });

  it('注册校验：非法用户名 / 弱密码 / 确认密码不一致 → 400', async () => {
    expect((await registerUser('ab')).status).toBe(400);
    expect(
      (await registerUser(uniq('weak'), { password: 'abcdefgh', confirmPassword: 'abcdefgh' }))
        .status,
    ).toBe(400);
    expect(
      (await registerUser(uniq('mismatch'), { confirmPassword: 'different1' })).status,
    ).toBe(400);
  });

  it('用户名并发重复注册：一个 201，其余 409', async () => {
    const username = uniq('race');
    const results = await Promise.all([registerUser(username), registerUser(username)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('check-username：已占用/可用/非法格式', async () => {
    const username = uniq('check');
    await registerUser(username);
    expect(
      (await api('GET', `/auth/check-username?username=${username}`)).data.available,
    ).toBe(false);
    expect(
      (await api('GET', `/auth/check-username?username=${uniq('free')}`)).data.available,
    ).toBe(true);
    expect((await api('GET', '/auth/check-username?username=x')).data.available).toBe(false);
  });
});

describe('登录与锁定', () => {
  it('登录成功返回令牌并更新 last_login_at', async () => {
    const username = uniq('login');
    await registerUser(username);
    const res = await api('POST', '/auth/login', { username, password: VALID_PW });
    expect(res.status).toBe(200);
    expect(res.data.accessToken).toBeTruthy();
    const rows = await dataSource.query(
      'SELECT last_login_at FROM users WHERE username = ?',
      [username],
    );
    expect(rows[0].last_login_at).not.toBeNull();
  });

  it('连续失败 5 次锁定 15 分钟：锁定判定先于密码校验，到期自动解锁', async () => {
    const username = uniq('lock');
    await registerUser(username);

    for (let i = 0; i < 4; i++) {
      const res = await api('POST', '/auth/login', { username, password: 'wrong111' });
      expect(res.status).toBe(401);
    }
    // 第 5 次失败触发锁定
    const fifth = await api('POST', '/auth/login', { username, password: 'wrong111' });
    expect(fifth.status).toBe(423);
    expect(fifth.data.lockedSeconds).toBeGreaterThan(0);
    expect(fifth.data.lockedSeconds).toBeLessThanOrEqual(900);

    // 锁定期间正确密码也拒绝（锁定判定先于密码校验），且返回剩余秒数
    const during = await api('POST', '/auth/login', { username, password: VALID_PW });
    expect(during.status).toBe(423);
    expect(during.data.lockedSeconds).toBeGreaterThan(0);

    // 模拟 15 分钟已过 → 自动解锁，登录成功且失败计数清零
    await dataSource.query(
      "UPDATE users SET locked_until = datetime('now', '-1 minute') WHERE username = ?",
      [username],
    );
    const res = await api('POST', '/auth/login', { username, password: VALID_PW });
    expect(res.status).toBe(200);
    const rows = await dataSource.query(
      'SELECT failed_login_attempts, locked_until FROM users WHERE username = ?',
      [username],
    );
    expect(rows[0].failed_login_attempts).toBe(0);
    expect(rows[0].locked_until).toBeNull();
  });

  it('锁定到期后失败计数重置为 0：再失败 4 次不锁、第 5 次锁；成功登录仍清零（3.1.2 文档外补充决策）', async () => {
    const username = uniq('lock2');
    await registerUser(username);

    // 先触发一次锁定
    for (let i = 0; i < 5; i++) {
      await api('POST', '/auth/login', { username, password: 'wrong111' });
    }
    const locked = await dataSource.query(
      'SELECT failed_login_attempts, locked_until FROM users WHERE username = ?',
      [username],
    );
    expect(locked[0].failed_login_attempts).toBe(5);
    expect(locked[0].locked_until).not.toBeNull();

    // 模拟锁定期已过 → 失败计数重置为 0，恢复完整 5 次失败机会
    await dataSource.query(
      "UPDATE users SET locked_until = datetime('now', '-1 minute') WHERE username = ?",
      [username],
    );

    // 解锁后再失败 4 次：均 401 且不触发锁定（旧语义下第 1 次失败即再锁）
    for (let i = 0; i < 4; i++) {
      const res = await api('POST', '/auth/login', { username, password: 'wrong111' });
      expect(res.status).toBe(401);
    }
    let rows = await dataSource.query(
      'SELECT failed_login_attempts, locked_until FROM users WHERE username = ?',
      [username],
    );
    expect(rows[0].failed_login_attempts).toBe(4);
    expect(rows[0].locked_until).toBeNull();

    // 第 5 次失败触发锁定
    const fifth = await api('POST', '/auth/login', { username, password: 'wrong111' });
    expect(fifth.status).toBe(423);

    // 再次到期后用正确密码登录成功，计数清零
    await dataSource.query(
      "UPDATE users SET locked_until = datetime('now', '-1 minute') WHERE username = ?",
      [username],
    );
    const ok = await api('POST', '/auth/login', { username, password: VALID_PW });
    expect(ok.status).toBe(200);
    rows = await dataSource.query(
      'SELECT failed_login_attempts, locked_until FROM users WHERE username = ?',
      [username],
    );
    expect(rows[0].failed_login_attempts).toBe(0);
    expect(rows[0].locked_until).toBeNull();
  });

  it('「记住我」Refresh 有效期 30 天，默认 14 天', async () => {
    const username = uniq('ttl');
    await registerUser(username);
    const normal = await api('POST', '/auth/login', { username, password: VALID_PW });
    const remember = await api('POST', '/auth/login', {
      username,
      password: VALID_PW,
      rememberMe: true,
    });
    // 注册自动登录 + 两次登录 = 3 条记录，取最后两条对比 TTL
    const rows = await dataSource.query(
      'SELECT created_at, expires_at FROM refresh_tokens WHERE user_id = ? ORDER BY id',
      [normal.data.user.id],
    );
    expect(rows).toHaveLength(3);
    const ttl = (r: { created_at: string; expires_at: string }) =>
      (parseDbDate(r.expires_at)!.getTime() - parseDbDate(r.created_at)!.getTime()) / 1000;
    const DAY = 24 * 3600;
    expect(Math.abs(ttl(rows[1]) - 14 * DAY)).toBeLessThan(60);
    expect(Math.abs(ttl(rows[2]) - 30 * DAY)).toBeLessThan(60);
  });
});

describe('令牌生命周期', () => {
  it('Refresh 轮换：新令牌可用，重放旧令牌 401', async () => {
    const username = uniq('rotate');
    await registerUser(username);
    const login = await api('POST', '/auth/login', { username, password: VALID_PW });
    const t1 = login.data.refreshToken as string;

    const rotated = await api('POST', '/auth/refresh', { refreshToken: t1 });
    expect(rotated.status).toBe(200);
    expect(rotated.data.refreshToken).not.toBe(t1);

    // 重放旧令牌 → 401
    const replay = await api('POST', '/auth/refresh', { refreshToken: t1 });
    expect(replay.status).toBe(401);

    // 新令牌可继续轮换
    const again = await api('POST', '/auth/refresh', {
      refreshToken: rotated.data.refreshToken,
    });
    expect(again.status).toBe(200);
  });

  it('登出后 Refresh 已吊销，刷新返回 401', async () => {
    const username = uniq('logout');
    await registerUser(username);
    const login = await api('POST', '/auth/login', { username, password: VALID_PW });
    const out = await api('POST', '/auth/logout', { refreshToken: login.data.refreshToken });
    expect(out.status).toBe(200);
    const res = await api('POST', '/auth/refresh', { refreshToken: login.data.refreshToken });
    expect(res.status).toBe(401);
  });

  it('Access 过期自动 Refresh 链路：受保护接口校验令牌', async () => {
    const username = uniq('session');
    const reg = await registerUser(username);
    const ok = await api('GET', '/auth/session', undefined, reg.data.accessToken);
    expect(ok.status).toBe(200);
    expect(ok.data.user.username).toBe(username);
    const bad = await api('GET', '/auth/session', undefined, 'invalid-token');
    expect(bad.status).toBe(401);
  });
});

describe('密保找回与改密', () => {
  it('密保重置：答案错误 400；重置后旧令牌全失效、旧密码不可用', async () => {
    const username = uniq('forgot');
    await registerUser(username);
    const login = await api('POST', '/auth/login', { username, password: VALID_PW });

    const wrong = await api('POST', '/auth/forgot-password', {
      username,
      securityAnswer: '错误答案',
      newPassword: NEW_PW,
    });
    expect(wrong.status).toBe(400);

    const reset = await api('POST', '/auth/forgot-password', {
      username,
      securityAnswer: '阳光小学',
      newPassword: NEW_PW,
    });
    expect(reset.status).toBe(200);

    // 旧 Refresh Token 全失效
    const refresh = await api('POST', '/auth/refresh', { refreshToken: login.data.refreshToken });
    expect(refresh.status).toBe(401);

    // 旧密码拒绝，新密码可登录
    expect(
      (await api('POST', '/auth/login', { username, password: VALID_PW })).status,
    ).toBe(401);
    expect(
      (await api('POST', '/auth/login', { username, password: NEW_PW })).status,
    ).toBe(200);
  });

  it('修改密码：验原密码；改后 Refresh 吊销、新密码可登录', async () => {
    const username = uniq('changepw');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;

    const wrong = await api(
      'POST',
      '/user/password',
      { oldPassword: 'nope0000', newPassword: NEW_PW },
      access,
    );
    expect(wrong.status).toBe(401);

    const weak = await api(
      'POST',
      '/user/password',
      { oldPassword: VALID_PW, newPassword: 'short' },
      access,
    );
    expect(weak.status).toBe(400);

    const ok = await api(
      'POST',
      '/user/password',
      { oldPassword: VALID_PW, newPassword: NEW_PW },
      access,
    );
    expect(ok.status).toBe(200);

    const refresh = await api('POST', '/auth/refresh', { refreshToken: reg.data.refreshToken });
    expect(refresh.status).toBe(401);
    expect(
      (await api('POST', '/auth/login', { username, password: NEW_PW })).status,
    ).toBe(200);
  });

  it('未携带/伪造令牌访问受保护接口 → 401', async () => {
    expect((await api('POST', '/user/password', { oldPassword: 'a1', newPassword: 'b2' })).status).toBe(401);
    expect((await api('DELETE', '/user', { confirm: true })).status).toBe(401);
  });
});

describe('账号注销', () => {
  it('二次确认 + 级联删除全部数据，注销后令牌失效、用户名可再注册', async () => {
    const username = uniq('delete');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;
    const userId = reg.data.user.id as number;

    // 二次确认：缺确认字段 / confirm=false 均拒绝
    expect((await api('DELETE', '/user', {}, access)).status).toBe(400);
    expect((await api('DELETE', '/user', { confirm: false }, access)).status).toBe(400);

    const res = await api('DELETE', '/user', { confirm: true }, access);
    expect(res.status).toBe(200);

    // 级联删除：各表均无该用户记录
    for (const table of [
      'users',
      'user_profiles',
      'user_wallets',
      'user_settings',
      'fund_flows',
      'refresh_tokens',
    ]) {
      const column = table === 'users' ? 'id' : 'user_id';
      const rows = await dataSource.query(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`, [
        userId,
      ]);
      expect(Number(rows[0].c)).toBe(0);
    }

    // 注销后旧令牌立即失效
    expect((await api('GET', '/auth/session', undefined, access)).status).toBe(401);
    expect(
      (await api('POST', '/auth/refresh', { refreshToken: reg.data.refreshToken })).status,
    ).toBe(401);

    // 用户名可再注册
    expect((await registerUser(username)).status).toBe(201);
  });
});
