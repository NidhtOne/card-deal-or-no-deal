/**
 * 卡池生成（docs/开发文档.md 3.6.2、七章.1）。
 *
 * 「权重扰动」算法合同（文档外补充，需人工评审；知识库只定义约束、未定义算法）：
 * 输入：档位模板 amountsFen[26]（升序唯一，含锚点）、weights[26]（>0）、档位上限 cap、
 *       公共配置 jitter J ∈ [0,1) 与 anchorAmountsFen、注入随机流。
 * 步骤：
 *  1. 锚点固定：模板值属于 anchorAmountsFen 的原样保留，不消耗随机流
 *     （保证每池必含 0.01/0.1/1/10/50 元小额锚点）。
 *  2. 非锚点 i：归一化权重 ŵ = w_i / max(w) ∈ (0,1]；抽 u = rng.next() ∈ [0,1)；
 *     乘子 m = 1 + J × (u − (1 − ŵ)) ∈ [1 − J(1−ŵ), 1 + J·ŵ)。
 *     权重越大上扰空间越大（ŵ=1 时 m ∈ [1, 1+J) 只上扰），权重越小越倾向下扰，
 *     以此体现「档位越高大额权重越高 → 大额更保值」（3.6.2 约束）；
 *     原始值 raw = Math.round(base × m)（四舍五入到分）。
 *  3. 钳制到 [1, cap]。
 *  4. 唯一性修复：若与已生成值冲突，按 +1, −1, +2, −2 … 顺序在 [1, cap] 内探测首个空位
 *     （纯确定性步进，不消耗随机流）；配置校验已保证 26 ≤ cap，空位必存在。
 *  5. Fisher–Yates 洗牌（消耗随机流）落位，输出数组下标即牌位。
 * 输出：26 个互不重复金额（分），全部 ∈ [1, cap]，必含全部锚点。
 * 不变量：同 seed 同配置 → 输出逐张一致；除注入随机流外不读任何外部状态。
 */
import type { RngStream } from './rng';
import type { CommonConfig, TierConfig } from './types';

/** 唯一性修复：从 value 出发按 +1,−1,+2,−2… 探测 [1,cap] 内首个未占用值（确定性） */
function placeUnique(value: number, used: Set<number>, cap: number): number {
  if (!used.has(value)) {
    used.add(value);
    return value;
  }
  for (let d = 1; ; d++) {
    const up = value + d;
    if (up <= cap && !used.has(up)) {
      used.add(up);
      return up;
    }
    const down = value - d;
    if (down >= 1 && !used.has(down)) {
      used.add(down);
      return down;
    }
    if (up > cap && down < 1) {
      // 理论上不可达：配置校验保证 26 个唯一正值 ≤ cap → cap ≥ 26 > 已占用数
      throw new Error('卡池唯一性修复失败：取值区间耗尽');
    }
  }
}

/** Fisher–Yates 洗牌（消费随机流，同流同结果） */
export function shuffle<T>(items: readonly T[], rng: RngStream): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.intBelow(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function generatePoolFen(tier: TierConfig, common: CommonConfig, rng: RngStream): number[] {
  const anchorSet = new Set(common.anchorAmountsFen);
  const maxWeight = Math.max(...tier.weights);
  const used = new Set<number>();
  const pool: number[] = [];
  for (let i = 0; i < tier.amountsFen.length; i++) {
    const base = tier.amountsFen[i];
    let value: number;
    if (anchorSet.has(base)) {
      value = base; // 步骤 1：锚点固定
    } else {
      // 步骤 2：权重定向扰动
      const wNorm = tier.weights[i] / maxWeight;
      const u = rng.next();
      const multiplier = 1 + common.poolJitter * (u - (1 - wNorm));
      value = Math.round(base * multiplier);
      // 步骤 3：钳制
      if (value < 1) value = 1;
      if (value > tier.maxPrizeFen) value = tier.maxPrizeFen;
    }
    pool.push(placeUnique(value, used, tier.maxPrizeFen)); // 步骤 4
  }
  return shuffle(pool, rng); // 步骤 5
}
