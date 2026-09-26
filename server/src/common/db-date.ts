/**
 * better-sqlite3 的 datetime 列读出值为 UTC 字符串（'YYYY-MM-DD HH:mm:ss[.SSS]'，
 * 视驱动行为也可能是 Date），统一解析为 Date；非法/空值返回 null。
 */
export function parseDbDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
