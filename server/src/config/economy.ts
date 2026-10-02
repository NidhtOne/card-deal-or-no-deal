import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from './paths';

/**
 * 经济系统配置加载（config/economy.json）。
 * 铁律 4：config 文件金额以「元」书写便于阅读，加载时统一转「分」（INTEGER）。
 * 铁律 7：所有游戏数值集中在 config/，代码中禁止硬编码档位/金额数值；
 * 这里的默认值仅用于配置文件缺失时的兜底（文档 3.8.1 建议初始赠送 10,000 元）。
 */

/** 元 → 分 */
export function yuanToFen(yuan: number): number {
  return Math.round(yuan * 100);
}

const DEFAULT_INITIAL_FUNDS_YUAN = 10000;

export interface EconomyConfig {
  /** 注册初始赠送，单位：分 */
  initialFundsFen: number;
}

let cached: EconomyConfig | null = null;

export function getEconomyConfig(): EconomyConfig {
  if (cached) return cached;
  let initialFundsYuan = DEFAULT_INITIAL_FUNDS_YUAN;
  try {
    const raw = readFileSync(join(REPO_ROOT, 'config', 'economy.json'), 'utf8');
    const json: unknown = JSON.parse(raw);
    if (
      typeof json === 'object' &&
      json !== null &&
      typeof (json as Record<string, unknown>).initial_funds === 'number'
    ) {
      initialFundsYuan = (json as Record<string, number>).initial_funds;
    }
  } catch {
    // 配置文件缺失/损坏时走默认值，保证本地一键可跑
  }
  cached = { initialFundsFen: yuanToFen(initialFundsYuan) };
  return cached;
}

// ---------- M4 经济扩展（签到/任务/救助/成就，docs/开发文档.md 3.8.2–3.8.5） ----------

/** 连签倍数档（整数万分比，10000 = ×1.0；铁律 4 延伸：奖励分 = baseFen × bp / 10000） */
export interface SigninMultiplierTier {
  /** 连签天数下限（含） */
  day: number;
  /** 倍数（万分比整数） */
  bp: number;
}

export interface SigninConfig {
  /** 基础奖励（分） */
  baseRewardFen: number;
  /** 倍数表：按 day 升序，取 day ≤ 连签天数 的最后一档 */
  multiplierBp: SigninMultiplierTier[];
}

/** 每日任务定义（tier=null 表示任意档位，如勤奋玩家） */
export interface TaskDefConfig {
  code: string;
  name: string;
  /** 限定档位 1–5；null = 任意档位 */
  tier: number | null;
  /** 当日需完成局数 */
  target: number;
  /** 奖励（分） */
  rewardFen: number;
}

export interface BailoutConfig {
  /** 申请门槛：余额 < thresholdFen 才可申请（分） */
  thresholdFen: number;
  /** 每次救助金额（分） */
  amountFen: number;
  /** 每日上限次数 */
  maxPerDay: number;
}

/** 成就定义（条件参数按 code 取用：prize_threshold/streak/games，详见 achievements.service） */
export interface AchievementDefConfig {
  code: string;
  name: string;
  /** 奖励（分） */
  rewardFen: number;
  /** 单局税前奖金门槛（分；百万梦想） */
  prizeThresholdFen: number | null;
  /** 连续盈利局数阈值（连胜猎手） */
  streak: number | null;
  /** 累计完成局数阈值（勤劳玩家） */
  games: number | null;
}

export interface EconomyExtConfig {
  signin: SigninConfig;
  tasks: TaskDefConfig[];
  bailout: BailoutConfig;
  achievements: AchievementDefConfig[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`economy.json 配置非法：${msg}`);
}

function reqPosYuan(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`${path} 必须为正数（元）`);
  return yuanToFen(v);
}

function reqPosInt(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) fail(`${path} 必须是正整数`);
  return v;
}

function reqNonEmptyStr(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(`${path} 必须是非空字符串`);
  return v;
}

function parseSignin(raw: unknown): SigninConfig {
  const rec = isRecord(raw) ? raw : fail('signin 必须是对象');
  const baseRewardFen = reqPosYuan(rec.base_reward, 'signin.base_reward');
  if (!Array.isArray(rec.multiplier_bp) || rec.multiplier_bp.length === 0) {
    fail('signin.multiplier_bp 必须是非空数组');
  }
  const multiplierBp: SigninMultiplierTier[] = (rec.multiplier_bp as unknown[]).map((item, i) => {
    const t = isRecord(item) ? item : fail(`signin.multiplier_bp[${i}] 必须是对象`);
    const day = reqPosInt(t.day, `signin.multiplier_bp[${i}].day`);
    const bp = reqPosInt(t.bp, `signin.multiplier_bp[${i}].bp`);
    return { day, bp };
  });
  for (let i = 1; i < multiplierBp.length; i++) {
    if (multiplierBp[i].day <= multiplierBp[i - 1].day) {
      fail('signin.multiplier_bp 的 day 必须严格递增');
    }
    if (multiplierBp[i].bp < multiplierBp[i - 1].bp) {
      fail('signin.multiplier_bp 的 bp 必须单调不减（连签越长奖励越高）');
    }
  }
  if (multiplierBp[0].day !== 1) fail('signin.multiplier_bp 首档 day 必须为 1');
  return { baseRewardFen, multiplierBp };
}

function parseTasks(raw: unknown): TaskDefConfig[] {
  const rec = isRecord(raw) ? raw : fail('tasks 必须是对象');
  if (!Array.isArray(rec.list) || rec.list.length === 0) fail('tasks.list 必须是非空数组');
  const seen = new Set<string>();
  return (rec.list as unknown[]).map((item, i) => {
    const path = `tasks.list[${i}]`;
    const t = isRecord(item) ? item : fail(`${path} 必须是对象`);
    const code = reqNonEmptyStr(t.code, `${path}.code`);
    if (seen.has(code)) fail(`tasks.list code 重复：${code}`);
    seen.add(code);
    const name = reqNonEmptyStr(t.name, `${path}.name`);
    let tier: number | null = null;
    if (t.tier !== null && t.tier !== undefined) {
      tier = reqPosInt(t.tier, `${path}.tier`);
      if (tier > 5) fail(`${path}.tier 必须在 1–5（五档，文档 3.6.1）`);
    }
    const target = reqPosInt(t.target, `${path}.target`);
    const rewardFen = reqPosYuan(t.reward, `${path}.reward`);
    return { code, name, tier, target, rewardFen };
  });
}

function parseBailout(raw: unknown): BailoutConfig {
  const rec = isRecord(raw) ? raw : fail('bailout 必须是对象');
  return {
    thresholdFen: reqPosYuan(rec.threshold, 'bailout.threshold'),
    amountFen: reqPosYuan(rec.amount, 'bailout.amount'),
    maxPerDay: reqPosInt(rec.max_per_day, 'bailout.max_per_day'),
  };
}

function parseAchievements(raw: unknown): AchievementDefConfig[] {
  const rec = isRecord(raw) ? raw : fail('achievements 必须是对象');
  if (!Array.isArray(rec.list) || rec.list.length === 0) {
    fail('achievements.list 必须是非空数组');
  }
  const seen = new Set<string>();
  return (rec.list as unknown[]).map((item, i) => {
    const path = `achievements.list[${i}]`;
    const t = isRecord(item) ? item : fail(`${path} 必须是对象`);
    const code = reqNonEmptyStr(t.code, `${path}.code`);
    if (seen.has(code)) fail(`achievements.list code 重复：${code}`);
    seen.add(code);
    const name = reqNonEmptyStr(t.name, `${path}.name`);
    const rewardFen = reqPosYuan(t.reward, `${path}.reward`);
    const prizeThresholdFen =
      t.prize_threshold === undefined || t.prize_threshold === null
        ? null
        : reqPosYuan(t.prize_threshold, `${path}.prize_threshold`);
    const streak =
      t.streak === undefined || t.streak === null ? null : reqPosInt(t.streak, `${path}.streak`);
    const games =
      t.games === undefined || t.games === null ? null : reqPosInt(t.games, `${path}.games`);
    return { code, name, rewardFen, prizeThresholdFen, streak, games };
  });
}

/**
 * 解析 M4 经济扩展段（signin/tasks/bailout/achievements）。纯函数，输入原始 JSON。
 * 与引擎 parseEconomyConfig 互补：引擎只消费 tax，此处消费 3.8.2–3.8.5 扩展段；
 * 非法配置抛错（getGameRawConfigs 处 fail fast，拒绝启动）。
 */
export function parseEconomyExt(raw: unknown): EconomyExtConfig {
  const rec = isRecord(raw) ? raw : fail('economy 配置根必须是对象');
  return {
    signin: parseSignin(rec.signin),
    tasks: parseTasks(rec.tasks),
    bailout: parseBailout(rec.bailout),
    achievements: parseAchievements(rec.achievements),
  };
}

let cachedExt: EconomyExtConfig | null = null;

/** 读取 M4 经济扩展配置（读 config/economy.json；文件缺失/损坏时抛错，M4 段为必填） */
export function getEconomyExt(): EconomyExtConfig {
  if (cachedExt) return cachedExt;
  const raw = readFileSync(join(REPO_ROOT, 'config', 'economy.json'), 'utf8');
  cachedExt = parseEconomyExt(JSON.parse(raw));
  return cachedExt;
}

/** 测试专用：清空配置缓存（如测试改写了 config 文件） */
export function resetEconomyConfigCache(): void {
  cached = null;
  cachedExt = null;
}
