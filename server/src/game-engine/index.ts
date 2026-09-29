/* istanbul ignore file -- 纯重导出桶文件：自身无逻辑，覆盖统计由各实现模块承担 */
/**
 * 对局核心引擎 —— 公共入口（纯 TypeScript，无任何 I/O 与框架依赖）。
 *
 * 公开 API 合同（供服务端接线阶段对齐）：
 *   createGame({ tierId, seed, tiersConfig, economyConfig }) → GameEngine
 *   命令：pickOwnCard(i) / flipCurrentRound() / respondOffer('deal' | 'noDeal' | { counter })
 *        / decideSwap(swap) / autoResolve() —— 每个命令返回追加的事件数组
 *   查询：getState()（JSON 可序列化快照）/ getLegalActions()
 *   恢复：restoreGame(snapshot)
 */
export * from './types';
export { createAlea } from './rng';
export type { AleaState, RngStream } from './rng';
export { ConfigError, POOL_SIZE, parseEconomyConfig, parseTiersConfig, yuanToFen } from './config';
export { generatePoolFen, shuffle } from './pool';
export { checkCounterLegal, evaluateCounter, meanFen, phaseForRound, rollOffer } from './offer';
export type { CounterOutcome } from './offer';
export { calcTaxFen, deriveQuickDeductions } from './tax';
export type { TaxResult } from './tax';
export { GameEngine, GameRuleError } from './engine';
export type { CreateGameOptions } from './engine';

import { GameEngine, type CreateGameOptions } from './engine';
import type { GameSnapshot } from './types';

/** 创建对局（配置为原始 JSON，引擎内解析校验、元转分） */
export function createGame(options: CreateGameOptions): GameEngine {
  return GameEngine.create(options);
}

/** 从 getState() 快照恢复对局 */
export function restoreGame(snapshot: GameSnapshot): GameEngine {
  return GameEngine.restore(snapshot);
}
