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

/**
 * 连胜盈利冻结机制（win_streak_guard）【文档外补充：2026-10-03 人工决策落地】。
 * 与「元」书写惯例不同（任务书硬性要求 1）：本段参数直接以最终存储单位表达，不做换算，
 * 注释标注避免歧义：
 * - trigger_profit_fen：连续盈利段税后净利累计和达到该值触发冻结（分）；
 * - keep_ratio_bp：冻结期间盈利局保留利润的整数万分比（5000 = 50%）；
 * - cap_fen：冻结期间单局入账利润封顶（分）；
 * - reset_hours：自触发时刻起 N 小时后自动解冻（整数小时，判定点=结算时）。
 * enabled=false 时四项可为 null 且不校验（功能关闭=结算逻辑零改动）；
 * enabled=true 时四项必须为非 null 正整数，否则启动直接 throw。
 */
export interface WinStreakGuardConfig {
  /** 功能总开关 */
  enabled: boolean;
  /** 触发阈值：连续盈利段税后净利累计和（分） */
  triggerProfitFen: number | null;
  /** 冻结期间保留利润比例（整数万分比，10000 = 100%） */
  keepRatioBp: number | null;
  /** 冻结期间单局入账利润封顶（分） */
  capFen: number | null;
  /** 触发后 N 小时自动解冻（整数小时） */
  resetHours: number | null;
}

/**
 * 对局历史过期清理【文档外补充：2026-10-03 人工决策落地】：
 * retention_options_days = 设置页可选保留天数白名单（整数天，0=永久保留），
 * user_settings.history_retention_days 必须落在此白名单内。
 */
export interface HistoryRetentionConfig {
  retentionOptionsDays: number[];
}

export interface EconomyExtConfig {
  signin: SigninConfig;
  tasks: TaskDefConfig[];
  bailout: BailoutConfig;
  achievements: AchievementDefConfig[];
  /** M8：连胜盈利冻结机制（文档外补充） */
  winStreakGuard: WinStreakGuardConfig;
  /** M8：历史清理保留选项（文档外补充） */
  history: HistoryRetentionConfig;
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

/** win_streak_guard 段解析【文档外补充：2026-10-03 人工决策落地】（见 WinStreakGuardConfig 注释） */
function parseWinStreakGuard(raw: unknown): WinStreakGuardConfig {
  const rec = isRecord(raw) ? raw : fail('win_streak_guard 必须是对象');
  const enabled = rec.enabled;
  if (typeof enabled !== 'boolean') fail('win_streak_guard.enabled 必须是布尔值');
  if (!enabled) {
    // 功能关闭：数值不校验（可为 null），结算逻辑零改动
    return {
      enabled,
      triggerProfitFen: null,
      keepRatioBp: null,
      capFen: null,
      resetHours: null,
    };
  }
  // 功能开启：四项必须为非 null 正整数（金额/万分比/小时均不换算，直接存储，注释见上）
  return {
    enabled,
    triggerProfitFen: reqPosInt(rec.trigger_profit_fen, 'win_streak_guard.trigger_profit_fen'),
    keepRatioBp: reqPosInt(rec.keep_ratio_bp, 'win_streak_guard.keep_ratio_bp'),
    capFen: reqPosInt(rec.cap_fen, 'win_streak_guard.cap_fen'),
    resetHours: reqPosInt(rec.reset_hours, 'win_streak_guard.reset_hours'),
  };
}

/** history 段解析【文档外补充：2026-10-03 人工决策落地】：保留天数白名单（非负整数、非空） */
function parseHistoryRetention(raw: unknown): HistoryRetentionConfig {
  const rec = isRecord(raw) ? raw : fail('history 必须是对象');
  if (!Array.isArray(rec.retention_options_days) || rec.retention_options_days.length === 0) {
    fail('history.retention_options_days 必须是非空数组');
  }
  const seen = new Set<number>();
  return {
    retentionOptionsDays: (rec.retention_options_days as unknown[]).map((v, i) => {
      const path = `history.retention_options_days[${i}]`;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        fail(`${path} 必须是非负整数（0=永久保留）`);
      }
      if (seen.has(v)) fail(`${path} 重复：${v}`);
      seen.add(v);
      return v;
    }),
  };
}

/**
 * 解析 M4 经济扩展段（signin/tasks/bailout/achievements + M8 win_streak_guard/history）。
 * 纯函数，输入原始 JSON。
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
    winStreakGuard: parseWinStreakGuard(rec.win_streak_guard),
    history: parseHistoryRetention(rec.history),
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

/**
 * 测试专用：整体替换 M4+ 扩展配置缓存【文档外补充：2026-10-03 人工决策落地】。
 * 用途：win_streak_guard 单测/集成测试注入测试内 fixture 值（任务书硬性要求 3：
 * 禁止把测试数值写进 config/economy.json，单元测试用测试内注入的 fixture 值）。
 * 禁止生产代码调用；调用后请用例结束恢复原配置，避免泄漏到其他用例。
 */
export function setEconomyExtCacheForTest(cfg: EconomyExtConfig | null): void {
  cachedExt = cfg;
}
