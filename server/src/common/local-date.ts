/**
 * 服务器本地日期工具（M4 经济系统：签到/任务/救助的「今日」与 00:00 重置判定）。
 * 统一约束 2：「今日」以服务器本地日期为准；业务代码一律从注入的 Clock.now() 取毫秒
 * 再走本模块换算（禁止散落 new Date() 直接判定「今日」，e2e 需要推进假时钟断言跨天）。
 */

/** 毫秒 epoch → 本地日期字符串 YYYY-MM-DD */
export function localDateOf(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 本地日期字符串 ± days 天（用本地正午构造规避 DST 边界） */
export function shiftLocalDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days, 12, 0, 0, 0);
  return localDateOf(dt.getTime());
}
