/**
 * 阶梯游戏税（AGENTS.md 铁律 8 修正版，docs/开发文档.md 3.6.7、七章.4）。纯函数。
 *
 * 修正版要点（旧速算扣除数 0/120/2120/10120/45120 与旧示例 1520 已作废，禁止引用）：
 * - 单局盈利 = 税前奖金 − 入场费；盈利 ≤ 0 → 税 0；盈亏不跨局抵扣；
 * - 应税金额 = max(0, 盈利 − 起征点)，级距作用于应税金额；
 * - 税 = 应税 × 对应级税率 − 速算扣除数；扣除数由代码自动推导，禁止硬编码；
 * - 验收例：盈利 20000 元 → 应税 19000 元 → 19000×10% − 350 = 税 1550 元。
 *
 * 实现说明（文档外补充）：
 * - 税率以「万分之一基点」整数存储（3% = 300），扣除数在「分·基点」整数域推导，
 *   全程整数运算，杜绝浮点尾差；
 * - 税额向下取整到分（文档外补充决策：应税×税率可能产生不足 1 分的尾数，一律舍去）。
 */
import type { TaxConfig } from './types';

export interface TaxResult {
  /** 应税金额 = max(0, 盈利 − 起征点)（分） */
  taxableFen: number;
  /** 命中税级（1 起）；免税时为 null */
  bracketLevel: number | null;
  /** 税额（分，向下取整） */
  taxFen: number;
}

/**
 * 速算扣除数自动推导（铁律 8 给定公式）：
 * d_1 = 0；d_i = d_{i-1} + 级距_{i-1} × (rate_i − rate_{i-1})。
 * 返回数组下标从 0 对应第 1 级；单位为「分·基点」（除以 10000 得「分」）。
 */
export function deriveQuickDeductions(tax: TaxConfig): number[] {
  const deductions: number[] = [0];
  for (let i = 1; i < tax.ratesBp.length; i++) {
    deductions.push(
      deductions[i - 1] + tax.bracketsFen[i - 1] * (tax.ratesBp[i] - tax.ratesBp[i - 1]),
    );
  }
  return deductions;
}

/**
 * 单局阶梯税。输入为单局盈利（整数分，可为负），输出税额（分）。
 * 级距为闭区间上沿：应税恰等于级距上限时按本级公式计税（边界连续性由推导公式保证）。
 */
export function calcTaxFen(profitFen: number, tax: TaxConfig): TaxResult {
  if (!Number.isInteger(profitFen)) {
    throw new Error('单局盈利必须是整数分（铁律 4）');
  }
  if (profitFen <= 0) {
    return { taxableFen: 0, bracketLevel: null, taxFen: 0 };
  }
  const taxableFen = profitFen - tax.thresholdFen;
  if (taxableFen <= 0) {
    return { taxableFen: 0, bracketLevel: null, taxFen: 0 };
  }
  let level = tax.ratesBp.length - 1;
  for (let i = 0; i < tax.bracketsFen.length; i++) {
    if (taxableFen <= tax.bracketsFen[i]) {
      level = i;
      break;
    }
  }
  const deductions = deriveQuickDeductions(tax);
  const taxFen = Math.floor((taxableFen * tax.ratesBp[level] - deductions[level]) / 10000);
  return { taxableFen, bracketLevel: level + 1, taxFen };
}
