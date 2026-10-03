import { expect, test, type Page } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * M5 阶段 7 Playwright E2E【文档外补充：工具链与用例均为本阶段新增，独立 test:e2e，不进 npm test】。
 *
 * 端到端全流程（路径确定性，不依赖 RNG 结果）：
 * 注册 → /profile/character 上传角色图（repo 内 fixture 图，走既有裁剪上传流程）→
 * 大厅选择取款机档（tier=1 自动跳过风险弹窗，3.11 触发点 1）→ 加载页（银行家 vs 用户角色）→
 * 选底牌 → 翻完第 1 轮 6 张 → 接受首个报价（Deal 结局）→ 结算页 →
 * 大厅签到（首日 ×1.0 确定性）→ /history 断言：
 * 该条记录 7 字段齐全且结果=成交离场、税额/盈亏与结算页一致；
 * /api/history/stats 6 项数字可由单局数据推导。
 * 环境隔离见 playwright.config.ts（独立临时库 + 独立端口，严禁触碰 ./data/game.db）。
 */

/** 与 web/src/utils/money.ts formatMoney 同逻辑（分 → 元，千分位） */
function formatMoney(fen: number): string {
  if (!Number.isSafeInteger(fen)) throw new RangeError(`金额必须是安全整数（分）：${fen}`);
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(fen);
  const yuan = Math.floor(abs / 100);
  const cents = abs % 100;
  const yuanText = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return cents === 0 ? `${sign}${yuanText}` : `${sign}${yuanText}.${String(cents).padStart(2, '0')}`;
}

/** 带正负号盈亏（与 formatSignedMoney 同逻辑） */
function formatSignedMoney(fen: number): string {
  return fen > 0 ? `+${formatMoney(fen)}` : formatMoney(fen);
}

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PNG = resolve(E2E_DIR, 'fixtures', 'character.png');
/** 本轮唯一用户名（时间戳后缀，隔离） */
const USERNAME = `e2e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const PASSWORD = 'abc12345';

/** 服务端 API 基址（经 vite dev server 的 /api 代理 → 后端） */
function apiOf(page: Page): string {
  return new URL(page.url()).origin + '/api';
}

/** 从浏览器会话取登录令牌（注册未勾「记住我」→ sessionStorage，dond.auth） */
async function accessToken(page: Page): Promise<string> {
  const raw = await page.evaluate(() => sessionStorage.getItem('dond.auth'));
  if (!raw) throw new Error('浏览器会话中无登录态');
  return (JSON.parse(raw) as { accessToken: string }).accessToken;
}

/** 与 server player-view 契约对齐的子集（本用例只消费结算相关字段） */
interface StateView {
  settlement: {
    reason: string;
    prizeFen: number;
    profitFen: number;
    taxFen: number;
    netFen: number;
  };
  entryFeeFen: number;
  netProfitFen: number;
}

interface HistoryApiItem {
  sessionId: number;
  matchedAt: string;
  tier: number;
  entryFeeFen: number;
  outcome: string;
  finalAmountFen: number;
  taxFen: number;
  netProfitFen: number;
}

interface HistoryApiList {
  total: number;
  items: HistoryApiItem[];
}

interface HistoryApiStats {
  totalMatches: number;
  totalNetProfitFen: number;
  winRate: number;
  maxNetProfitFen: number;
  tierDistribution: { tier: number; count: number }[];
  totalTaxFen: number;
}

/** 带登录态的服务端 GET（Playwright request 上下文） */
async function authGet<T>(page: Page, path: string): Promise<T> {
  const token = await accessToken(page);
  const res = await page.request.get(`${apiOf(page)}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status(), `GET ${path} 应为 200`).toBe(200);
  return (await res.json()) as T;
}

test.describe('M5 阶段 7：完赛 → 签到 → /history 全流程（附录 A 15/16 真实浏览器复核）', () => {
  test('注册 → 上传角色图 → 取款机档完赛（Deal）→ 签到 → 历史与统计断言', async ({ page }) => {
    test.setTimeout(240_000);

    // ---------- 1. 注册（UI，3.1.1：成功自动登录进入大厅） ----------
    await page.goto('/register');
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await page.fill('#confirmPassword', PASSWORD);
    await page.fill('#securityQuestion', '我的小学名称？');
    await page.fill('#securityAnswer', '阳光小学');
    await page.getByRole('button', { name: '注册并进入大厅' }).click();
    await expect(page).toHaveURL(/\/lobby$/);

    // ---------- 2. 上传角色图（repo 内 fixture，3.3；走既有裁剪上传流程） ----------
    await page.getByRole('link', { name: '我的角色' }).click();
    await expect(page).toHaveURL(/\/profile\/character$/);
    await expect(page.getByText('暂无历史立绘')).toBeVisible();
    await page.getByRole('button', { name: '上传立绘' }).click();
    await page.locator('input[type="file"]').first().setInputFiles(FIXTURE_PNG);
    // 裁剪器就绪后确认上传（react-easy-crop 默认构图即合法）
    await expect(page.getByRole('button', { name: '确认上传' })).toBeEnabled();
    await page.getByRole('button', { name: '确认上传' }).click();
    await expect(page.getByText('使用中')).toBeVisible({ timeout: 30_000 });

    // ---------- 3. 大厅选择取款机档（tier=1，自动跳过风险弹窗，3.11 触发点 1） ----------
    await page.getByRole('link', { name: '游戏大厅' }).click();
    await expect(page).toHaveURL(/\/lobby$/);
    await page.getByRole('button', { name: /取款机/ }).click();
    await expect(page).toHaveURL(/\/match\/load\/\d+$/);

    // ---------- 4. 加载页：银行家 vs 用户双方角色（附录 A 15 前半句，真实浏览器复核） ----------
    const bankerImg = page.getByAltText('银行家');
    const playerImg = page.getByAltText('我的角色');
    await expect(bankerImg).toBeVisible({ timeout: 20_000 });
    await expect(playerImg).toBeVisible();
    await expect(page.getByText('VS', { exact: true })).toBeVisible();
    // 上传过的角色图生效（不再是占位剪影）
    const playerSrc = await playerImg.getAttribute('src');
    expect(playerSrc).toContain('/uploads/characters/');
    // 布局：银行家居左、用户居右（真实浏览器用横坐标断言）
    const bankerBox = await bankerImg.boundingBox();
    const playerBox = await playerImg.boundingBox();
    expect(bankerBox).not.toBeNull();
    expect(playerBox).not.toBeNull();
    expect(bankerBox!.x).toBeLessThan(playerBox!.x);

    // ---------- 5. 等待 VS 动效播完自动进对局页；选底牌 + 翻完第 1 轮 6 张 ----------
    await expect(page).toHaveURL(/\/match\/play\/\d+$/, { timeout: 30_000 });
    await expect(page.getByText('选择 1 张牌作为本局底牌')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:not([disabled]):has-text("?")').first().click();

    // 逐张翻 6 张（第 1 轮固定 6 张；点击后顶栏「已翻 N 张」递增）
    for (let i = 1; i <= 6; i++) {
      await page.locator('button:not([disabled]):has-text("?")').first().click();
      await expect(page.getByText(`已翻 ${i} 张`)).toBeVisible({ timeout: 10_000 });
    }

    // ---------- 6. 接受首个报价（Deal 结局，路径确定性不依赖 RNG） ----------
    await expect(page.getByRole('button', { name: '成交 Deal' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: '成交 Deal' }).click();
    await expect(page.getByText('成交！', { exact: true })).toBeVisible();
    // 结算动画（约 2.6 秒）后自动跳结算页
    await expect(page).toHaveURL(/\/match\/result\/\d+$/, { timeout: 20_000 });
    await expect(page.getByText('对局结算')).toBeVisible();

    // 记录服务端权威结算数据（后续 /history 断言与此一致）
    const sessionId = Number(page.url().match(/\/match\/result\/(\d+)$/)![1]);
    const st = await authGet<StateView>(page, `/match/${sessionId}/state`);
    expect(st.settlement.reason).toBe('deal');

    // 结算页与结算数据一致（税额/盈亏与结算页一致 —— 任务书 §5）
    const settleBody = page.locator('main');
    await expect(settleBody).toContainText(`¥${formatMoney(st.settlement.prizeFen)}`);
    await expect(settleBody).toContainText(`¥${formatMoney(st.settlement.taxFen)}`);
    await expect(settleBody).toContainText(`${formatSignedMoney(st.netProfitFen)} 元`);
    await expect(settleBody).toContainText(`¥${formatMoney(st.entryFeeFen)}`);

    // ---------- 7. 返回大厅，签到（首日 ×1.0 确定性） ----------
    await page.getByRole('link', { name: '返回大厅' }).click();
    await expect(page).toHaveURL(/\/lobby$/);
    // 完赛首局解锁「初出茅庐」：大厅必然弹出待领取成就（3.8.5）→ 一键领取（领取后不再弹，避免遮罩反复拦截；成就会改变余额但不影响历史/统计口径）
    await expect(page.getByText('成就达成！')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '一键领取' }).click();
    await expect(page.getByText('成就达成！')).toBeHidden();
    await expect(page.getByText('成就奖励已全部领取')).toBeVisible();
    await page.getByRole('button', { name: '签到' }).click();
    await expect(page.getByRole('heading', { name: '每日签到' })).toBeVisible();
    await page.getByRole('button', { name: '立即签到' }).click();
    // 首日 ×1.0：奖励 = 签到基数 100 元（config/economy.json base_reward）
    await expect(page.getByText('签到成功！')).toBeVisible();
    await expect(page.locator('main')).toContainText(/奖励 ¥100（×1）/);
    // 关闭签到弹窗（固定遮罩会拦截后续导航点击）
    await page.getByRole('button', { name: '✕' }).click();
    await expect(page.getByText('签到成功！')).toBeHidden();

    // ---------- 8. /history：列表 7 字段 + 统计面板 6 项 ----------
    await page.getByRole('link', { name: '对决历史' }).click();
    await expect(page).toHaveURL(/\/history$/);
    await expect(page.getByRole('heading', { name: '对决历史' })).toBeVisible();

    // 铁律 10：页脚固定声明仍在
    await expect(
      page.getByText('本游戏为纯虚拟娱乐，无任何充值与变现功能，游戏资金无现实价值'),
    ).toBeVisible();

    // 统计面板 6 项（单局数据推导；scoped 到统计 section 防列表同文案歧义）
    const statsSection = page
      .locator('section')
      .filter({ hasText: '各档位参与分布' });
    await expect(statsSection).toContainText('累计对局');
    await expect(statsSection).toContainText('1 局');
    await expect(statsSection).toContainText(
      st.netProfitFen > 0 ? '100%' : st.netProfitFen < 0 ? '0%' : '0%',
    );
    await expect(statsSection).toContainText(`${formatSignedMoney(st.netProfitFen)} 元`); // 累计净盈亏
    await expect(statsSection).toContainText(`¥${formatMoney(st.settlement.taxFen)}`); // 累计交税总额
    // 各档位参与分布：仅取款机 1 局（文本跨嵌套 span，用整体 textContent 匹配）
    await expect(statsSection.locator('span', { hasText: '取款机' })).toHaveText('取款机1 局');

    // 列表：该条记录 7 字段齐全且结果=成交离场、税额/盈亏与结算页一致（scoped 到表格）
    const table = page.locator('table tbody');
    await expect(table).toContainText('成交离场');
    await expect(table).toContainText(`¥${formatMoney(st.entryFeeFen)}`); // 入场消耗
    await expect(table).toContainText(`¥${formatMoney(st.settlement.prizeFen)}`); // 最终报价
    await expect(table).toContainText(`¥${formatMoney(st.settlement.taxFen)}`); // 税额
    await expect(table).toContainText(`${formatSignedMoney(st.netProfitFen)} 元`); // 实际盈亏
    await expect(
      page.locator('td', { hasText: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/ }),
    ).toBeVisible(); // 对局时间精确到分钟
    await expect(page.getByText('共 1 条 · 第 1 / 1 页')).toBeVisible();

    // ---------- 9. API 断言：/api/history 7 字段 + /api/history/stats 6 项可推导 ----------
    const history = await authGet<HistoryApiList>(page, '/history');
    expect(history.total).toBe(1);
    expect(history.items).toHaveLength(1);
    const item = history.items[0];
    // 7 字段齐全（sessionId 行标识 + 3.10 逐字 7 字段）
    expect(Object.keys(item).sort()).toEqual(
      [
        'sessionId',
        'matchedAt',
        'tier',
        'entryFeeFen',
        'outcome',
        'finalAmountFen',
        'taxFen',
        'netProfitFen',
      ].sort(),
    );
    expect(item.sessionId).toBe(sessionId);
    expect(item.tier).toBe(1);
    expect(item.entryFeeFen).toBe(st.entryFeeFen);
    expect(item.outcome).toBe('成交离场'); // settlement.reason='deal' → 成交离场（映射钦定）
    expect(item.finalAmountFen).toBe(st.settlement.prizeFen); // 最终报价
    expect(item.taxFen).toBe(st.settlement.taxFen); // 税额与结算一致
    expect(item.netProfitFen).toBe(st.netProfitFen); // 盈亏与结算一致（到手 − 入场费）
    expect(item.matchedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const stats = await authGet<HistoryApiStats>(page, '/history/stats');
    // 6 项全部可由单局数据推导
    expect(stats.totalMatches).toBe(1);
    expect(stats.totalNetProfitFen).toBe(st.netProfitFen);
    expect(stats.winRate).toBe(st.netProfitFen > 0 ? 1 : 0); // 盈利局/完赛总局
    expect(stats.maxNetProfitFen).toBe(st.netProfitFen);
    expect(stats.totalTaxFen).toBe(st.settlement.taxFen);
    expect(stats.tierDistribution).toEqual([
      { tier: 1, count: 1 },
      { tier: 2, count: 0 },
      { tier: 3, count: 0 },
      { tier: 4, count: 0 },
      { tier: 5, count: 0 },
    ]);
  });
});
