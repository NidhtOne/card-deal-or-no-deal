import { calcTaxFen, deriveQuickDeductions } from './tax';
import type { TaxConfig } from './types';
import { createAlea } from './rng';

/** 铁律 8 修正版标准配置：起征点 1000 元，级距 5000/20000/100000/500000 元，税率 3%/10%/20%/28%/35% */
const TAX: TaxConfig = {
  thresholdFen: 100000, // 1000 元
  bracketsFen: [500000, 2000000, 10000000, 50000000], // 5000/2万/10万/50万 元
  ratesBp: [300, 1000, 2000, 2800, 3500],
};

/** 朴素超额累进参考实现（测试内独立实现，用于交叉验证） */
function naiveTaxFen(profitFen: number, tax: TaxConfig): number {
  if (profitFen <= 0) return 0;
  let taxable = profitFen - tax.thresholdFen;
  if (taxable <= 0) return 0;
  let totalBp = 0; // 税（分·基点）
  let prevCap = 0;
  for (let i = 0; i < tax.ratesBp.length; i++) {
    const cap = i < tax.bracketsFen.length ? tax.bracketsFen[i] : Number.POSITIVE_INFINITY;
    const slice = Math.min(taxable, cap) - prevCap;
    if (slice > 0) totalBp += slice * tax.ratesBp[i];
    prevCap = cap;
    if (taxable <= cap) break;
  }
  taxable = 0; // 防误用
  return Math.floor(totalBp / 10000);
}

describe('game-engine/tax：速算扣除数自动推导（禁止硬编码）', () => {
  it('推导结果 = 修正版 0/350/2350/10350/45350 元', () => {
    const d = deriveQuickDeductions(TAX);
    // 返回值单位是「分·基点」，除以 10000 还原为分
    expect(d.map((v) => v / 10000)).toEqual([0, 35000, 235000, 1035000, 4535000]);
  });
});

describe('game-engine/tax：calcTaxFen 修正版验收（铁律 8）', () => {
  it('① 盈利 20000 元 → 应税 19000 元 → 税 1550 元', () => {
    const r = calcTaxFen(2000000, TAX);
    expect(r.taxableFen).toBe(1900000);
    expect(r.bracketLevel).toBe(2);
    expect(r.taxFen).toBe(155000);
  });

  it('② 亏损/零盈利 → 税 0（盈亏不跨局抵扣，负盈利直接免征）', () => {
    expect(calcTaxFen(0, TAX).taxFen).toBe(0);
    expect(calcTaxFen(-38800, TAX).taxFen).toBe(0);
    expect(calcTaxFen(-1, TAX).taxFen).toBe(0);
    expect(calcTaxFen(-38800, TAX).bracketLevel).toBeNull();
  });

  it('③ 盈利 ≤ 1000 元（起征点）免征', () => {
    expect(calcTaxFen(100000, TAX).taxFen).toBe(0); // 恰 1000 元
    expect(calcTaxFen(99999, TAX).taxFen).toBe(0);
    expect(calcTaxFen(1, TAX).taxFen).toBe(0);
  });

  it('④ 每个级距边界 ±1 分', () => {
    // 边界点（应税 = 级距）按低级的公式（闭区间上沿）
    for (const bracket of TAX.bracketsFen) {
      const profit = bracket + TAX.thresholdFen;
      const at = calcTaxFen(profit, TAX);
      const above = calcTaxFen(profit + 1, TAX);
      const below = calcTaxFen(profit - 1, TAX);
      // 边界处命中更低税级
      const level = TAX.bracketsFen.indexOf(bracket) + 1;
      expect(at.bracketLevel).toBe(level);
      expect(above.bracketLevel).toBe(level + 1);
      expect(below.bracketLevel).toBe(level);
      // 单调不减
      expect(above.taxFen).toBeGreaterThanOrEqual(at.taxFen);
      expect(at.taxFen).toBeGreaterThanOrEqual(below.taxFen);
    }
  });

  it('⑤ 边界连续性：应税恰 20000 元时级 2 与级 3 公式等额 = 1650 元', () => {
    const taxable = 2000000;
    // 级 2 公式：应税×10% − 350 元（扣除数换算到「分·基点」域：35000 分 × 10000）
    const level2 = Math.floor((taxable * 1000 - 35000 * 10000) / 10000);
    // 级 3 公式：应税×20% − 2350 元
    const level3 = Math.floor((taxable * 2000 - 235000 * 10000) / 10000);
    expect(level2).toBe(165000);
    expect(level3).toBe(165000);
    expect(calcTaxFen(taxable + TAX.thresholdFen, TAX).taxFen).toBe(165000);
  });

  it('⑥ 大额跨多档：盈利 1000000 元 → 应税 999000 元 → 级 5 → 税 304300 元', () => {
    const r = calcTaxFen(100000000, TAX);
    expect(r.bracketLevel).toBe(5);
    expect(r.taxableFen).toBe(99900000);
    expect(r.taxFen).toBe(30430000);
  });

  it('⑦ 税额向下取整到分（文档外补充决策）', () => {
    // 应税 333 分：333×3% = 9.99 分 → 9 分
    const r = calcTaxFen(TAX.thresholdFen + 333, TAX);
    expect(r.taxFen).toBe(9);
    // 应税 1 分：0.03 分 → 0 分
    expect(calcTaxFen(TAX.thresholdFen + 1, TAX).taxFen).toBe(0);
  });

  it('非整数盈利抛错（铁律 4：金额为整数分）', () => {
    expect(() => calcTaxFen(1.5, TAX)).toThrow();
  });
});

describe('game-engine/tax：与朴素累进参考实现交叉验证', () => {
  it('确定性伪随机扫描 2000 个盈利点（含全部边界 ±1 分邻域）', () => {
    const rng = createAlea('tax-cross-check');
    const points = new Set<number>();
    // 边界邻域强制覆盖
    for (const b of TAX.bracketsFen) {
      for (const d of [-2, -1, 0, 1, 2]) points.add(b + TAX.thresholdFen + d);
    }
    points.add(TAX.thresholdFen);
    points.add(0);
    // 覆盖 0 ~ 120 万元盈利区间
    while (points.size < 2000) {
      points.add(Math.floor(rng.next() * 120000000));
    }
    for (const profit of points) {
      expect(calcTaxFen(profit, TAX).taxFen).toBe(naiveTaxFen(profit, TAX));
    }
  });
});
