import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';

/**
 * 用户中心与角色系统集成测试（docs/开发文档.md 3.2/3.3/五/6.2）：
 * 资料/用户名 30 天限制、设置 8 字段、上传校验（类型/大小/重编码去 EXIF/伪造扩展名）、
 * 角色历史保留 3 张与淘汰、内置银行家白名单、注销磁盘清理。
 */

jest.setTimeout(120000);

// 库路径由 setup-env 按 worker 分配（import 提升导致此处赋值无效，勿再加）
// 测试上传目录使用独立临时目录，避免污染仓库 storage/
const tmpDir = mkdtempSync(join(tmpdir(), 'dond-user-test-'));
process.env.STORAGE_DIR = join(tmpDir, 'storage');

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

interface TestFile {
  name: string;
  type: string;
  data: Buffer;
}

/** multipart 上传（字段名 file） */
async function upload(
  path: string,
  file: TestFile | null,
  accessToken?: string,
  fields?: Record<string, string>,
): Promise<ApiResult> {
  const form = new FormData();
  if (file) {
    form.append('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
  }
  if (fields) {
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
  }
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    body: form,
  });
  let data: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  } catch {
    /* 空响应体 */
  }
  return { status: res.status, data };
}

/** /uploads/<subdir>/<name> → 临时 STORAGE_DIR 下的磁盘绝对路径 */
function urlToDisk(url: string): string {
  expect(url.startsWith('/uploads/')).toBe(true);
  return join(process.env.STORAGE_DIR!, url.slice('/uploads/'.length));
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  const suffix = `${Date.now().toString(36).slice(-4)}${seq.toString(36)}`;
  return `${prefix}${suffix}`.slice(0, 16);
}

const VALID_PW = 'abc12345';

async function registerUser(username: string): Promise<ApiResult> {
  return api('POST', '/auth/register', {
    username,
    password: VALID_PW,
    confirmPassword: VALID_PW,
    securityQuestion: '我的小学名称？',
    securityAnswer: '阳光小学',
  });
}

/** 生成纯色 PNG（默认 800×600） */
function pngBuffer(width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
}

/** 生成带 EXIF 的 JPEG */
async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 300, height: 300, channels: 3, background: '#aa5522' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'e2e-test-copyright', Software: 'jest' } })
    .toBuffer();
}

/** 最小合法 1×1 GIF（用于「真实格式不在白名单」用例） */
const GIF_1PX = Buffer.from(
  '47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b',
  'hex',
);

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
});

afterAll(async () => {
  await app?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('鉴权', () => {
  it('未登录访问用户接口 → 401', async () => {
    expect((await api('GET', '/user/profile')).status).toBe(401);
    expect((await api('PUT', '/user/profile', { nickname: 'x' })).status).toBe(401);
    expect((await api('GET', '/user/settings')).status).toBe(401);
    expect((await api('GET', '/user/overview')).status).toBe(401);
    expect((await api('GET', '/user/character/history')).status).toBe(401);
    expect((await api('GET', '/user/banker-options')).status).toBe(401);
    expect((await upload('/user/avatar', null)).status).toBe(401);
  });
});

describe('资料与用户名（3.2）', () => {
  it('GET profile 初始值：昵称为用户名，其余为空；PUT 昵称/签名往返一致，空串清除为 null', async () => {
    const username = uniq('prof');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;

    const got = await api('GET', '/user/profile', undefined, access);
    expect(got.status).toBe(200);
    expect(got.data).toMatchObject({
      username,
      nickname: username,
      signature: null,
      avatarUrl: null,
      characterUrl: null,
      bankerCharacterUrl: null,
      usernameChangedAt: null,
    });

    const updated = await api(
      'PUT',
      '/user/profile',
      { nickname: '  昵称甲  ', signature: '胜负乃兵家常事' },
      access,
    );
    expect(updated.status).toBe(200);
    expect(updated.data.nickname).toBe('昵称甲');
    expect(updated.data.signature).toBe('胜负乃兵家常事');

    // 空字符串视为清除（存 NULL）
    const cleared = await api('PUT', '/user/profile', { nickname: '', signature: '' }, access);
    expect(cleared.status).toBe(200);
    expect(cleared.data.nickname).toBeNull();
    expect(cleared.data.signature).toBeNull();
  });

  it('用户名：首改直接允许 → 30 天内再改拒绝 → 满 30 天允许 → 重名 409 → 非法格式 400', async () => {
    const userA = uniq('usera');
    const userB = uniq('userb');
    const regA = await registerUser(userA);
    await registerUser(userB);
    const access = regA.data.accessToken as string;

    // 首改（username_changed_at 为 NULL）直接允许
    const first = await api('PUT', '/user/profile', { username: uniq('newa') }, access);
    expect(first.status).toBe(200);
    expect(first.data.usernameChangedAt).not.toBeNull();

    // 30 天内再改 → 400
    const tooSoon = await api('PUT', '/user/profile', { username: uniq('newb') }, access);
    expect(tooSoon.status).toBe(400);

    // 模拟距上次 29 天 → 仍拒绝
    await dataSource.query(
      "UPDATE user_profiles SET username_changed_at = datetime('now', '-29 days') WHERE user_id = ?",
      [regA.data.user.id],
    );
    expect((await api('PUT', '/user/profile', { username: uniq('newc') }, access)).status).toBe(
      400,
    );

    // 模拟距上次 30 天 → 允许
    await dataSource.query(
      "UPDATE user_profiles SET username_changed_at = datetime('now', '-30 days') WHERE user_id = ?",
      [regA.data.user.id],
    );
    const after30 = await api('PUT', '/user/profile', { username: uniq('newd') }, access);
    expect(after30.status).toBe(200);

    // 重名 → 409（先重置修改时间以排除频率限制干扰）
    await dataSource.query(
      'UPDATE user_profiles SET username_changed_at = NULL WHERE user_id = ?',
      [regA.data.user.id],
    );
    const dup = await api('PUT', '/user/profile', { username: userB }, access);
    expect(dup.status).toBe(409);

    // 非法格式 → 400
    expect((await api('PUT', '/user/profile', { username: 'ab' }, access)).status).toBe(400);
    expect(
      (await api('PUT', '/user/profile', { username: '含中文名abcd' }, access)).status,
    ).toBe(400);
  });

  it('并发双改不同新用户名 → 恰好一个 200、一个 400（M1 原子盖章 + 用户级串行锁）', async () => {
    const username = uniq('race');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;

    const [r1, r2] = await Promise.all([
      api('PUT', '/user/profile', { username: uniq('ra1') }, access),
      api('PUT', '/user/profile', { username: uniq('ra2') }, access),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 400]);

    // 胜者的盖章必须已提交：立即再改 → 400（额度已消耗）
    const third = await api('PUT', '/user/profile', { username: uniq('ra3') }, access);
    expect(third.status).toBe(400);
  });

  it('重名 409 后立即改一个合法未占用名 → 200（改名失败不消耗 30 天额度，M1）', async () => {
    const userC = uniq('userc');
    const userD = uniq('userd');
    const regC = await registerUser(userC);
    await registerUser(userD);
    const access = regC.data.accessToken as string;

    // 首改撞重名 → 409（事务回滚，盖章撤销）
    const dup = await api('PUT', '/user/profile', { username: userD }, access);
    expect(dup.status).toBe(409);

    // 409 未消耗额度：立即改合法未占用名仍允许
    const ok = await api('PUT', '/user/profile', { username: uniq('newe') }, access);
    expect(ok.status).toBe(200);
    // 这次成功已盖章：再改 → 400
    expect((await api('PUT', '/user/profile', { username: uniq('newf') }, access)).status).toBe(
      400,
    );
  });
});

describe('设置（3.7 / 6.2）', () => {
  it('GET 默认 8 字段 + 曲目白名单；PUT 全字段往返一致；volume 越界/非整数 400；bgm_track 白名单', async () => {
    const username = uniq('set');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;

    const got = await api('GET', '/user/settings', undefined, access);
    expect(got.status).toBe(200);
    expect(got.data).toMatchObject({
      bgmEnabled: true,
      volume: 60,
      sfxEnabled: true,
      sfxVolume: 80,
      amountListEnabled: true,
      riskPopupEnabled: true,
      achievementEnabled: true,
    });
    // 曲目白名单 = assets/music/ 现有音频文件（占位曲目，阶段 6 新增 loading.wav；
    // README.md 说明文档与 sfx/ 子目录不参与白名单）；存储的默认值不在白名单时回退到第一首
    expect(got.data.availableTracks).toEqual([
      'finale.wav',
      'loading.wav',
      'lobby.wav',
      'match.wav',
    ]);
    expect(got.data.bgmTrack).toBe('finale.wav');

    // 8 字段全量更新 → 往返一致
    const full = {
      bgmEnabled: false,
      bgmTrack: 'match.wav',
      volume: 0,
      sfxEnabled: false,
      sfxVolume: 100,
      amountListEnabled: false,
      riskPopupEnabled: false,
      achievementEnabled: false,
    };
    const put = await api('PUT', '/user/settings', full, access);
    expect(put.status).toBe(200);
    expect(put.data).toMatchObject(full);
    const roundtrip = await api('GET', '/user/settings', undefined, access);
    expect(roundtrip.data).toMatchObject(full);

    // volume / sfx_volume 越界与非整数 → 400
    expect((await api('PUT', '/user/settings', { volume: 101 }, access)).status).toBe(400);
    expect((await api('PUT', '/user/settings', { volume: -1 }, access)).status).toBe(400);
    expect((await api('PUT', '/user/settings', { sfxVolume: 60.5 }, access)).status).toBe(400);

    // bgm_track 白名单
    expect((await api('PUT', '/user/settings', { bgmTrack: 'evil.wav' }, access)).status).toBe(
      400,
    );
    expect((await api('PUT', '/user/settings', { bgmTrack: 'lobby.wav' }, access)).status).toBe(
      200,
    );
  });
});

describe('头像上传（3.2；附录 A：用户头像与角色图均由用户自行上传——头像部分）', () => {
  it('有效 PNG：重编码落盘 + 多尺寸缩略图；带 EXIF 的 JPG 输出无 EXIF', async () => {
    const username = uniq('avatar');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;

    // PNG 上传
    const png = await pngBuffer();
    const res = await upload('/user/avatar', { name: 'a.png', type: 'image/png', data: png }, access);
    expect(res.status).toBe(201);
    const url = res.data.url as string;
    expect(url.startsWith('/uploads/avatars/')).toBe(true);
    const mainPath = urlToDisk(url);
    expect(existsSync(mainPath)).toBe(true);
    // 主图 512×512 + 缩略图 256/64（文档未定义规格 —— 实现决策）
    const meta = await sharp(readFileSync(mainPath)).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
    const stem = url.replace(/\.[a-z0-9]+$/i, '');
    const ext = /\.[a-z0-9]+$/i.exec(url)![0];
    expect(existsSync(urlToDisk(`${stem}_256${ext}`))).toBe(true);
    expect(existsSync(urlToDisk(`${stem}_64${ext}`))).toBe(true);

    // 带 EXIF 的 JPG：输入确实有 EXIF，服务端输出必须无 EXIF
    const jpg = await jpegWithExif();
    expect((await sharp(jpg).metadata()).exif).toBeTruthy();
    const res2 = await upload(
      '/user/avatar',
      { name: 'exif.jpg', type: 'image/jpeg', data: jpg },
      access,
    );
    expect(res2.status).toBe(201);
    const outMeta = await sharp(readFileSync(urlToDisk(res2.data.url))).metadata();
    expect(outMeta.exif).toBeUndefined();
    // 更换头像：旧主图与缩略图被删除（先更库后删旧文件）
    expect(existsSync(mainPath)).toBe(false);
    expect(existsSync(urlToDisk(`${stem}_256${ext}`))).toBe(false);
    expect(existsSync(urlToDisk(`${stem}_64${ext}`))).toBe(false);
  });

  it('伪造扩展名/伪装类型/超限 → 4xx', async () => {
    const username = uniq('fake');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;

    // 文本内容伪装成 PNG（伪造扩展名）→ sharp 解码失败 400
    const fakePng = await upload(
      '/user/avatar',
      { name: 'fake.png', type: 'image/png', data: Buffer.from('not an image at all') },
      access,
    );
    expect(fakePng.status).toBe(400);

    // 真实 GIF（扩展名/mimetype 均伪装为 png）→ 真实格式不在白名单 400
    const gif = await upload(
      '/user/avatar',
      { name: 'g.png', type: 'image/png', data: GIF_1PX },
      access,
    );
    expect(gif.status).toBe(400);

    // mimetype 不在白名单 → 400（服务端二次校验）
    const wrongMime = await upload(
      '/user/avatar',
      { name: 'a.png', type: 'image/gif', data: await pngBuffer() },
      access,
    );
    expect(wrongMime.status).toBe(400);

    // 超 5MB → multer limits 拦截（413）或服务端二次校验（400）
    const oversize = await upload(
      '/user/avatar',
      {
        name: 'big.png',
        type: 'image/png',
        data: Buffer.alloc(5 * 1024 * 1024 + 1, 1),
      },
      access,
    );
    expect([400, 413]).toContain(oversize.status);

    // 缺少文件 → 400
    expect((await upload('/user/avatar', null, access)).status).toBe(400);
  });
});

describe('角色系统（3.3；附录 A：用户头像与角色图均由用户自行上传——角色图部分）', () => {
  it('历史初始为空；上传 4 张淘汰最旧（记录与磁盘文件同删）；历史切换', async () => {
    const username = uniq('char');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;
    const userId = reg.data.user.id as number;

    // 未上传时返回空（前端用 assets/placeholders/ 剪影）
    const empty = await api('GET', '/user/character/history', undefined, access);
    expect(empty.status).toBe(200);
    expect(empty.data.items).toEqual([]);
    expect(empty.data.activeUrl).toBeNull();

    // 连续上传 4 张
    const urls: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await upload(
        '/user/character',
        { name: `c${i}.png`, type: 'image/png', data: await pngBuffer(300, 400) },
        access,
      );
      expect(res.status).toBe(201);
      urls.push(res.data.url as string);
    }

    // 保留最近 3 张，第 4 张上传时淘汰最旧（记录与磁盘文件同删）
    const history = await api('GET', '/user/character/history', undefined, access);
    expect(history.data.items).toHaveLength(3);
    const historyUrls = history.data.items.map((it: { url: string }) => it.url);
    expect(historyUrls).not.toContain(urls[0]);
    expect(existsSync(urlToDisk(urls[0]))).toBe(false);
    for (const u of urls.slice(1)) {
      expect(historyUrls).toContain(u);
      expect(existsSync(urlToDisk(u))).toBe(true);
    }

    // 当前生效图 = 最新上传
    const profile = await api('GET', '/user/profile', undefined, access);
    expect(profile.data.characterUrl).toBe(urls[3]);

    // 历史切换：激活最旧保留张
    const target = history.data.items[2];
    const activated = await api('POST', `/user/character/${target.id}/activate`, {}, access);
    expect(activated.status).toBe(200);
    expect(activated.data.url).toBe(target.url);
    const after = await api('GET', '/user/character/history', undefined, access);
    expect(after.data.activeUrl).toBe(target.url);

    // 切换不存在的记录 → 404
    expect((await api('POST', '/user/character/999999/activate', {}, access)).status).toBe(404);

    // DB 侧同样只剩 3 条
    const rows = await dataSource.query(
      'SELECT COUNT(*) AS c FROM user_character_images WHERE user_id = ?',
      [userId],
    );
    expect(Number(rows[0].c)).toBe(3);
  });
});

describe('银行家角色（3.3 / 6.2）', () => {
  it('内置列表；选择内置白名单与路径穿越拒绝；上传自定义；切回内置删除旧自定义文件', async () => {
    const username = uniq('banker');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;

    // 内置选项（assets/bankers/ 下 3 张占位立绘）
    const options = await api('GET', '/user/banker-options', undefined, access);
    expect(options.status).toBe(200);
    expect(options.data.builtin.map((b: { filename: string }) => b.filename)).toEqual([
      'banker-1.png',
      'banker-2.png',
      'banker-3.png',
    ]);
    expect(options.data.defaultUrl).toBe('/assets/bankers/banker-1.png');
    expect(options.data.currentUrl).toBeNull();

    // 选择内置（JSON 模式）
    const picked = await api(
      'POST',
      '/user/banker-character',
      { filename: 'banker-2.png' },
      access,
    );
    expect(picked.status).toBe(200);
    expect(picked.data.url).toBe('/assets/bankers/banker-2.png');

    // 路径穿越与不存在文件 → 400
    for (const bad of ['../secret.png', '..\\banker-1.png', 'a/b.png', 'nonexistent.png']) {
      expect(
        (await api('POST', '/user/banker-character', { filename: bad }, access)).status,
      ).toBe(400);
    }

    // 上传自定义（multipart 模式，存 bankers-custom/）
    const custom = await upload(
      '/user/banker-character',
      { name: 'bk.png', type: 'image/png', data: await pngBuffer(300, 400) },
      access,
    );
    expect(custom.status).toBe(200);
    const customUrl = custom.data.url as string;
    expect(customUrl.startsWith('/uploads/bankers-custom/')).toBe(true);
    expect(existsSync(urlToDisk(customUrl))).toBe(true);

    // 切回内置：旧自定义文件删除
    const back = await api(
      'POST',
      '/user/banker-character',
      { filename: 'banker-3.png' },
      access,
    );
    expect(back.status).toBe(200);
    expect(existsSync(urlToDisk(customUrl))).toBe(false);

    // 既无文件也无文件名 → 400
    expect((await api('POST', '/user/banker-character', {}, access)).status).toBe(400);
  });
});

describe('账户聚合 overview（文档外补充）', () => {
  it('余额为真实值（分）；新用户无完赛局，统计三项为 0（与 /api/history/stats 同源）', async () => {
    const username = uniq('ov');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;

    const res = await api('GET', '/user/overview', undefined, access);
    expect(res.status).toBe(200);
    expect(res.data.balance).toBe(1000000); // 初始赠送 10,000 元 → 分
    expect(res.data).toMatchObject({
      todaySignedIn: false,
      signinStreakDays: 0,
      todayBailoutUsed: 0,
      totalMatches: 0,
      totalProfit: 0,
      winRate: 0,
    });
  });
});

describe('账号注销级联清理（3.1.3）', () => {
  it('注销后 user_character_images 级联删除，头像/角色/自定义银行家磁盘文件全部清理', async () => {
    const username = uniq('del');
    const reg = await registerUser(username);
    const access = reg.data.accessToken as string;
    const userId = reg.data.user.id as number;

    // 上传头像 + 角色图 + 自定义银行家
    const avatar = await upload(
      '/user/avatar',
      { name: 'a.png', type: 'image/png', data: await pngBuffer() },
      access,
    );
    const avatarUrl = avatar.data.url as string;
    const avatarStem = avatarUrl.replace(/\.[a-z0-9]+$/i, '');
    const avatarExt = /\.[a-z0-9]+$/i.exec(avatarUrl)![0];
    const character = await upload(
      '/user/character',
      { name: 'c.png', type: 'image/png', data: await pngBuffer(300, 400) },
      access,
    );
    const banker = await upload(
      '/user/banker-character',
      { name: 'b.png', type: 'image/png', data: await pngBuffer(300, 400) },
      access,
    );
    const diskFiles = [
      urlToDisk(avatarUrl),
      urlToDisk(`${avatarStem}_256${avatarExt}`),
      urlToDisk(`${avatarStem}_64${avatarExt}`),
      urlToDisk(character.data.url),
      urlToDisk(banker.data.url),
    ];
    for (const f of diskFiles) expect(existsSync(f)).toBe(true);

    const res = await api('DELETE', '/user', { confirm: true }, access);
    expect(res.status).toBe(200);

    // DB 级联删除（含文档外补充表 user_character_images）
    for (const table of ['users', 'user_profiles', 'user_character_images']) {
      const column = table === 'users' ? 'id' : 'user_id';
      const rows = await dataSource.query(
        `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`,
        [userId],
      );
      expect(Number(rows[0].c)).toBe(0);
    }

    // 磁盘上传文件全部清理
    for (const f of diskFiles) expect(existsSync(f)).toBe(false);
  });
});
