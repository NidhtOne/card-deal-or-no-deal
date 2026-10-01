/**
 * 金额展示工具（AGENTS.md 铁律 4）：
 * 传输/存储一律整数「分」，禁止浮点参与运算；仅展示层在此做分→元格式化。
 *
 * formatMoney(38800) === '388'
 * formatMoney(1) === '0.01'
 * formatMoney(388800) === '3,888'
 * formatMoney(-2000000) === '-20,000'
 */

/** 分 → 元字符串：整元不带小数，非整元固定两位小数，千分位分隔 */
export function formatMoney(fen: number): string {
  if (!Number.isSafeInteger(fen)) {
    throw new RangeError(`金额必须是安全整数（分）：${fen}`);
  }
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(fen);
  const yuan = Math.floor(abs / 100);
  const cents = abs % 100;
  const yuanText = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return cents === 0 ? `${sign}${yuanText}` : `${sign}${yuanText}.${String(cents).padStart(2, '0')}`;
}

/** 带正负号的盈亏展示：>0 前缀「+」，=0 不带符号，<0 自带「-」 */
export function formatSignedMoney(fen: number): string {
  return fen > 0 ? `+${formatMoney(fen)}` : formatMoney(fen);
}

/**
 * 还价弹窗输入解析（任务书 §4：UI 以元展示、整数输入，提交前 ×100 转整数分）。
 * 仅接受十进制整数字符串（允许首尾空格，禁止逗号/小数点/负号/科学计数法），
 * 返回整数分；非法输入返回 null（本地驳回，不发请求、不消耗本轮还价次数）。
 */
export function parseIntegerYuanToFen(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,12}$/.test(trimmed)) return null;
  const fen = Number(trimmed) * 100;
  return Number.isSafeInteger(fen) ? fen : null;
}
