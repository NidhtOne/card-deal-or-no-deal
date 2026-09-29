/**
 * 档位映射表（server 侧常量，任务书 §1 钦定，注释标注）：
 * DB game_sessions.tier INTEGER 1–5（文档 5.1） ↔ 引擎 tierId（config/tiers.json 键）：
 *   1=atm 2=beginner 3=standard 4=advanced 5=master
 */
export const TIER_ID_BY_INT = ['atm', 'beginner', 'standard', 'advanced', 'master'] as const;

/** tier INTEGER（1–5）→ 引擎 tierId；非法返回 null */
export function tierIdByInt(tier: number): string | null {
  if (!Number.isInteger(tier) || tier < 1 || tier > TIER_ID_BY_INT.length) return null;
  return TIER_ID_BY_INT[tier - 1];
}

/** 引擎 tierId → tier INTEGER（1–5）；未知返回 null */
export function tierIntById(tierId: string): number | null {
  const idx = (TIER_ID_BY_INT as readonly string[]).indexOf(tierId);
  return idx < 0 ? null : idx + 1;
}
