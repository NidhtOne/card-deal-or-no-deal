import { describe, expect, it } from 'vitest';
import { formatMoney, formatSignedMoney, parseIntegerYuanToFen } from './money';

describe('formatMoney（分→元，铁律 4）', () => {
  it('整元不带小数', () => {
    expect(formatMoney(0)).toBe('0');
    expect(formatMoney(100)).toBe('1');
    expect(formatMoney(38800)).toBe('388');
    expect(formatMoney(2000000)).toBe('20,000');
  });

  it('非整元固定两位小数', () => {
    expect(formatMoney(1)).toBe('0.01');
    expect(formatMoney(10)).toBe('0.10');
    expect(formatMoney(99)).toBe('0.99');
    expect(formatMoney(38885)).toBe('388.85');
    expect(formatMoney(38880)).toBe('388.80');
  });

  it('千分位分隔', () => {
    expect(formatMoney(388800)).toBe('3,888');
    expect(formatMoney(100000000)).toBe('1,000,000');
    expect(formatMoney(123456789)).toBe('1,234,567.89');
  });

  it('负数（盈亏展示）', () => {
    expect(formatMoney(-1)).toBe('-0.01');
    expect(formatMoney(-38800)).toBe('-388');
    expect(formatMoney(-2000000)).toBe('-20,000');
  });

  it('拒绝非安全整数（浮点/越界一律抛错，禁止带病渲染）', () => {
    expect(() => formatMoney(1.5)).toThrow(RangeError);
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => formatMoney(NaN)).toThrow(RangeError);
  });
});

describe('formatSignedMoney（盈亏带符号）', () => {
  it('正数带 +，负数带 -，零不带符号', () => {
    expect(formatSignedMoney(155000)).toBe('+1,550');
    expect(formatSignedMoney(-38800)).toBe('-388');
    expect(formatSignedMoney(0)).toBe('0');
  });
});

describe('parseIntegerYuanToFen（还价整数元输入 → 整数分）', () => {
  it('合法整数元', () => {
    expect(parseIntegerYuanToFen('0')).toBe(0);
    expect(parseIntegerYuanToFen('1')).toBe(100);
    expect(parseIntegerYuanToFen('388')).toBe(38800);
    expect(parseIntegerYuanToFen(' 10000 ')).toBe(1000000);
  });

  it('非法输入返回 null（小数/负号/逗号/字母/空串/科学计数法）', () => {
    expect(parseIntegerYuanToFen('')).toBeNull();
    expect(parseIntegerYuanToFen('1.5')).toBeNull();
    expect(parseIntegerYuanToFen('-100')).toBeNull();
    expect(parseIntegerYuanToFen('1,000')).toBeNull();
    expect(parseIntegerYuanToFen('abc')).toBeNull();
    expect(parseIntegerYuanToFen('1e3')).toBeNull();
    expect(parseIntegerYuanToFen('１２３')).toBeNull();
  });
});
