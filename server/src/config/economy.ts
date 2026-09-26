import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from './paths';

/**
 * 经济系统配置加载（config/economy.json）。
 * 铁律 4：config 文件金额以「元」书写便于阅读，加载时统一转「分」（INTEGER）。
 * 铁律 7：所有游戏数值集中在 config/，代码中禁止硬编码档位/金额数值；
 * 这里的默认值仅用于配置文件缺失时的兜底（文档 3.8.1 建议初始赠送 10,000 元）。
 */

/** 元 → 分 */
export function yuanToFen(yuan: number): number {
  return Math.round(yuan * 100);
}

const DEFAULT_INITIAL_FUNDS_YUAN = 10000;

export interface EconomyConfig {
  /** 注册初始赠送，单位：分 */
  initialFundsFen: number;
}

let cached: EconomyConfig | null = null;

export function getEconomyConfig(): EconomyConfig {
  if (cached) return cached;
  let initialFundsYuan = DEFAULT_INITIAL_FUNDS_YUAN;
  try {
    const raw = readFileSync(join(REPO_ROOT, 'config', 'economy.json'), 'utf8');
    const json: unknown = JSON.parse(raw);
    if (
      typeof json === 'object' &&
      json !== null &&
      typeof (json as Record<string, unknown>).initial_funds === 'number'
    ) {
      initialFundsYuan = (json as Record<string, number>).initial_funds;
    }
  } catch {
    // 配置文件缺失/损坏时走默认值，保证本地一键可跑
  }
  cached = { initialFundsFen: yuanToFen(initialFundsYuan) };
  return cached;
}

/** 测试专用：清空配置缓存（如测试改写了 config 文件） */
export function resetEconomyConfigCache(): void {
  cached = null;
}
