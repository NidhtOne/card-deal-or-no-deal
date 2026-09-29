/**
 * 配置解析与校验（config/tiers.json、config/economy.json 的引擎侧入口）。
 * 纯函数：输入为原始 JSON（unknown），输出为校验通过、金额已转「分」的强类型配置；
 * 非法配置一律抛 ConfigError。文件读取由服务端接线阶段负责（本目录禁止 I/O）。
 *
 * 铁律 4：config 以「元」书写，此处统一 Math.round(元×100) 转分；
 * 铁律 7：所有游戏数值只从配置读取，引擎其余模块禁止硬编码。
 */
import type {
  CommonConfig,
  EconomyConfig,
  KRange,
  OfferPhase,
  TaxConfig,
  TierConfig,
  TiersConfig,
} from './types';

/** 每局卡牌数（3.6.2 固定 26 张） */
export const POOL_SIZE = 26;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 元 → 分。铁律 4 钦定 Math.round 防浮点尾差。
 * 注：与 server/src/config/economy.ts 中同名函数为同源复制——引擎目录禁止 import
 * 任何会触碰 I/O 的模块，故在此自持一份纯函数。
 */
export function yuanToFen(yuan: number): number {
  return Math.round(yuan * 100);
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} 必须是对象`);
  return value;
}

function reqNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} 必须是有限数字`);
  return value;
}

function reqPositiveNumber(value: unknown, path: string): number {
  const n = reqNumber(value, path);
  if (n <= 0) fail(`${path} 必须为正数`);
  return n;
}

function reqPositiveInt(value: unknown, path: string): number {
  const n = reqNumber(value, path);
  if (!Number.isInteger(n) || n <= 0) fail(`${path} 必须是正整数`);
  return n;
}

function reqNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} 必须是非空字符串`);
  return value;
}

function reqNumberArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) fail(`${path} 必须是数组`);
  return value.map((v, i) => reqNumber(v, `${path}[${i}]`));
}

function parseKRange(value: unknown, path: string): KRange {
  const rec = reqRecord(value, path);
  const min = reqNumber(rec.min, `${path}.min`);
  const max = reqNumber(rec.max, `${path}.max`);
  if (min < 0 || max > 1 || min > max) {
    fail(`${path} 必须满足 0 ≤ min ≤ max ≤ 1（k 区间 ⊆ [0,1]，3.6.4）`);
  }
  return { min, max };
}

function parseCommon(raw: unknown): CommonConfig {
  const rec = reqRecord(raw, 'common');

  const flipSequence = reqNumberArray(rec.flip_sequence, 'common.flip_sequence').map((v, i) =>
    reqPositiveInt(v, `common.flip_sequence[${i}]`),
  );
  if (flipSequence.length === 0) fail('common.flip_sequence 不能为空');
  // 26 张牌翻至剩 2 张进终局，总共只能翻 24 张；序列和 > 24 会破坏 3.6.3 的固定节奏
  const flipSum = flipSequence.reduce((a, b) => a + b, 0);
  if (flipSum > POOL_SIZE - 2) {
    fail(`common.flip_sequence 之和（${flipSum}）不得超过 ${POOL_SIZE - 2}（26 张翻至剩 2 张）`);
  }

  const poolJitter = reqNumber(rec.pool_jitter, 'common.pool_jitter');
  if (poolJitter < 0 || poolJitter >= 1) fail('common.pool_jitter 必须落在 [0, 1)');

  const kRangesRaw = reqRecord(rec.k_ranges, 'common.k_ranges');
  const kRanges: Record<OfferPhase, KRange> = {
    early: parseKRange(kRangesRaw.early, 'common.k_ranges.early'),
    mid: parseKRange(kRangesRaw.mid, 'common.k_ranges.mid'),
    final: parseKRange(kRangesRaw.final, 'common.k_ranges.final'),
  };

  const phaseRaw = reqRecord(rec.k_phase_rounds, 'common.k_phase_rounds');
  const earlyMaxRound = reqPositiveInt(
    phaseRaw.early_max_round,
    'common.k_phase_rounds.early_max_round',
  );
  const midMaxRound = reqPositiveInt(phaseRaw.mid_max_round, 'common.k_phase_rounds.mid_max_round');
  if (earlyMaxRound > midMaxRound) {
    fail('common.k_phase_rounds 必须满足 early_max_round ≤ mid_max_round');
  }

  const counterRaw = reqRecord(rec.counter, 'common.counter');
  const acceptRatio = reqNumber(counterRaw.accept_ratio, 'common.counter.accept_ratio');
  const probHi = reqNumber(counterRaw.prob_hi, 'common.counter.prob_hi');
  const probLo = reqNumber(counterRaw.prob_lo, 'common.counter.prob_lo');
  if (acceptRatio <= 0 || acceptRatio >= 1) fail('common.counter.accept_ratio 必须落在 (0, 1)');
  if (probHi < 0 || probHi > 1 || probLo < 0 || probLo > 1) {
    fail('common.counter.prob_hi / prob_lo 必须落在 [0, 1]');
  }
  if (probHi < probLo) fail('common.counter.prob_hi 不得小于 prob_lo');

  const anchorYuan = reqNumberArray(rec.anchor_amounts, 'common.anchor_amounts');
  if (anchorYuan.length === 0) fail('common.anchor_amounts 不能为空');
  anchorYuan.forEach((v, i) => {
    if (v <= 0) fail(`common.anchor_amounts[${i}] 必须为正数`);
  });
  const anchorAmountsFen = anchorYuan.map(yuanToFen);
  if (new Set(anchorAmountsFen).size !== anchorAmountsFen.length) {
    fail('common.anchor_amounts 转分后存在重复');
  }

  return {
    flipSequence,
    poolJitter,
    kRanges,
    kPhaseRounds: { earlyMaxRound, midMaxRound },
    counter: { acceptRatio, probHi, probLo },
    anchorAmountsFen,
  };
}

function parseTier(id: string, raw: unknown, anchorFen: number[]): TierConfig {
  const path = `tiers.${id}`;
  const rec = reqRecord(raw, path);
  const name = reqNonEmptyString(rec.name, `${path}.name`);
  const entryFeeFen = yuanToFen(reqPositiveNumber(rec.entry_fee, `${path}.entry_fee`));
  const maxPrizeFen = yuanToFen(reqPositiveNumber(rec.max_prize, `${path}.max_prize`));

  const amountsYuan = reqNumberArray(rec.amounts, `${path}.amounts`);
  if (amountsYuan.length !== POOL_SIZE) fail(`${path}.amounts 必须为 ${POOL_SIZE} 张模板金额`);
  const amountsFen = amountsYuan.map((v, i) => {
    if (v <= 0) fail(`${path}.amounts[${i}] 必须 > 0`);
    return yuanToFen(v);
  });
  const seen = new Set<number>();
  for (const fen of amountsFen) {
    if (seen.has(fen)) fail(`${path}.amounts 存在重复金额（${fen} 分，转分后唯一性校验）`);
    seen.add(fen);
    if (fen > maxPrizeFen)
      fail(`${path}.amounts 含超过档位上限的金额（${fen} > ${maxPrizeFen} 分）`);
  }
  for (const anchor of anchorFen) {
    if (!seen.has(anchor)) fail(`${path}.amounts 缺少小额锚点 ${anchor} 分（3.6.2）`);
  }

  const weights = reqNumberArray(rec.weights, `${path}.weights`);
  if (weights.length !== POOL_SIZE) fail(`${path}.weights 必须为 ${POOL_SIZE} 个权重`);
  weights.forEach((w, i) => {
    if (!(w > 0)) fail(`${path}.weights[${i}] 必须 > 0`);
  });

  // 模板约定升序存储；对乱序输入做排序并让权重跟随金额对齐
  const order = amountsFen.map((_, i) => i).sort((a, b) => amountsFen[a] - amountsFen[b]);
  return {
    id,
    name,
    entryFeeFen,
    maxPrizeFen,
    amountsFen: order.map((i) => amountsFen[i]),
    weights: order.map((i) => weights[i]),
  };
}

export function parseTiersConfig(raw: unknown): TiersConfig {
  const rec = reqRecord(raw, 'tiers 配置根');
  const common = parseCommon(rec.common);
  const tiersRaw = reqRecord(rec.tiers, 'tiers');
  const tierOrder = Object.keys(tiersRaw);
  if (tierOrder.length === 0) fail('tiers 至少要定义一个档位');
  const tiers: Record<string, TierConfig> = {};
  for (const id of tierOrder) {
    tiers[id] = parseTier(id, tiersRaw[id], common.anchorAmountsFen);
  }
  return { tiers, tierOrder, common };
}

function parseTax(raw: unknown): TaxConfig {
  const rec = reqRecord(raw, 'economy.tax');
  const thresholdYuan = reqNumber(rec.threshold, 'economy.tax.threshold');
  if (thresholdYuan < 0) fail('economy.tax.threshold 不得为负');
  const thresholdFen = yuanToFen(thresholdYuan);

  const bracketsYuan = reqNumberArray(rec.brackets, 'economy.tax.brackets');
  if (bracketsYuan.length === 0) fail('economy.tax.brackets 不能为空');
  const bracketsFen = bracketsYuan.map((v, i) => {
    if (v <= 0) fail(`economy.tax.brackets[${i}] 必须为正数`);
    return yuanToFen(v);
  });
  for (let i = 1; i < bracketsFen.length; i++) {
    if (bracketsFen[i] <= bracketsFen[i - 1]) {
      fail('economy.tax.brackets 必须严格递增（转分后判定）');
    }
  }

  const rates = reqNumberArray(rec.rates, 'economy.tax.rates');
  if (rates.length !== bracketsFen.length + 1) {
    fail('economy.tax.rates 条数必须 = 级距数 + 1（铁律 8：五级税率对应四段级距）');
  }
  const ratesBp = rates.map((r, i) => {
    if (r <= 0 || r > 1) fail(`economy.tax.rates[${i}] 必须落在 (0, 1]`);
    const bp = r * 10000;
    if (Math.abs(bp - Math.round(bp)) > 1e-6) {
      fail(`economy.tax.rates[${i}] 必须可表示为万分之一（基点）整数，保证整数税算无浮点尾差`);
    }
    return Math.round(bp);
  });
  for (let i = 1; i < ratesBp.length; i++) {
    if (ratesBp[i] <= ratesBp[i - 1]) {
      fail('economy.tax.rates 必须严格递增（超额累进语义）');
    }
  }
  return { thresholdFen, bracketsFen, ratesBp };
}

export function parseEconomyConfig(raw: unknown): EconomyConfig {
  const rec = reqRecord(raw, 'economy 配置根');
  // signin / tasks / bailout / achievements 为后续阶段预留空节，引擎只消费 tax
  return { tax: parseTax(rec.tax) };
}
