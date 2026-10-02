import { readFileSync } from 'fs';
import { join } from 'path';
import { parseEconomyConfig, parseTiersConfig } from '../game-engine';
import { parseEconomyExt } from './economy';
import { REPO_ROOT } from './paths';

/**
 * 对局配置原始 JSON 加载（config/tiers.json、config/economy.json）。
 * 扩展现有 server/src/config/ 加载层：I/O 只允许在这一层。
 * 缓存的是「原始 JSON」，供 createGame({ tierId, seed, tiersConfig, economyConfig })
 * 直接使用（引擎内自行解析校验、元转分；铁律 4/7）。
 * 加载时用引擎 parse 函数预校验一遍：非法配置启动即失败（fail fast）。
 */
export interface GameRawConfigs {
  tiersRaw: unknown;
  economyRaw: unknown;
}

let cached: GameRawConfigs | null = null;

function loadRawJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'config', rel), 'utf8'));
}

export function getGameRawConfigs(): GameRawConfigs {
  if (cached) return cached;
  const tiersRaw = loadRawJson('tiers.json');
  const economyRaw = loadRawJson('economy.json');
  // fail fast：配置非法时抛 ConfigError，拒绝启动
  parseTiersConfig(tiersRaw);
  parseEconomyConfig(economyRaw);
  // M4 经济扩展段（3.8.2–3.8.5）同样启动即校验
  parseEconomyExt(economyRaw);
  cached = { tiersRaw, economyRaw };
  return cached;
}

/** 测试专用：清空配置缓存 */
export function resetGameConfigCache(): void {
  cached = null;
}
