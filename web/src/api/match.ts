import axios from 'axios';
import { api } from './client';

/**
 * 对局 REST 客户端（服务端契约为唯一字段来源，禁止臆造字段）：
 * - REST 路径与响应结构：server/src/match/match.controller.ts
 * - 玩家视图字段：server/src/match/player-view.ts 的 PlayerView（逐字段对齐）
 * 金额一律整数分（铁律 4），展示层统一走 utils/money 分→元。
 */

/** 引擎状态机驻留态（与 server/src/game-engine/types.ts GameStatus 对齐；REVEAL/TAX 为引擎内瞬态） */
export type EngineStatus =
  | 'PICK_OWN_CARD'
  | 'FLIP_ROUND_N'
  | 'BANKER_OFFER'
  | 'FINAL_OFFER'
  | 'SWAP_DECISION'
  | 'REVEAL'
  | 'TAX'
  | 'SETTLE';

export type OfferPhase = 'early' | 'mid' | 'final';
export type SettleReason = 'deal' | 'counter' | 'keep' | 'swap';

/** 玩家视图 DTO（= server player-view.ts PlayerView，脱敏：不含 seed/rngState/未翻牌位金额） */
export interface PlayerView {
  sessionId: number;
  /** 档位 1–5 */
  tier: number;
  /** DB 对局状态：进行/成交/终局/超时结算 */
  status: string;
  engineStatus: EngineStatus;
  /** 当前轮次（1 起；未进轮次为 0） */
  round: number;
  /** 本轮待翻张数（仅翻牌态有意义） */
  flipQuota: number;
  /** 底牌位置（不含金额！） */
  ownCardPosition: number | null;
  /** 已翻牌位与金额（已淘汰公共牌） */
  flippedCards: { position: number; amountFen: number }[];
  /** 剩余张数（含底牌） */
  remainingCount: number;
  /** 当前报价（无待响应报价为 null） */
  currentOffer: {
    round: number | null;
    isFinal: boolean;
    phase: OfferPhase;
    offerFen: number;
  } | null;
  /** 本轮还价机会是否已消耗 */
  counterUsed: boolean;
  /** 超时截止时间（ISO 字符串） */
  timeoutDeadline: string;
  /** 结算结果（已结算时存在） */
  settlement: {
    reason: SettleReason;
    prizeFen: number;
    profitFen: number;
    taxFen: number;
    netFen: number;
  } | null;
  /** 税后入账后的余额快照（分；未结算为 null） */
  settledBalanceFen: number | null;
  /** 实际盈亏 = 税后到手 − 入场费（分；未结算为 null） */
  netProfitFen: number | null;
  entryFeeFen: number;
  tierMaxPrizeFen: number;
  startedAt: string | null;
  finishedAt: string | null;
}

/** GET /api/match/tiers（任务书 §0 文档外补充）：大厅档位卡片数据源，禁止前端硬编码档位数值 */
export interface TierInfo {
  tier: number;
  name: string;
  entryFeeFen: number;
  maxPrizeFen: number;
}

/** GET /api/match/:id/amount-list（受 user_settings.amount_list_enabled 开关控制） */
export interface AmountListView {
  enabled: boolean;
  amounts: { amountFen: number; eliminated: boolean }[];
}

export const matchApi = {
  getTiers: () => api.get<TierInfo[]>('/match/tiers').then((r) => r.data),
  /** 开局：clientKey 为幂等键（双击/重试复用同一 key，防重复扣费） */
  start: (tier: number, clientKey: string) =>
    api
      .post<{ sessionId: number; state: PlayerView }>('/match/start', { tier, clientKey })
      .then((r) => r.data),
  getState: (sessionId: number) =>
    api.get<PlayerView>(`/match/${sessionId}/state`).then((r) => r.data),
  pick: (sessionId: number, index: number) =>
    api.post<{ state: PlayerView }>(`/match/${sessionId}/pick`, { index }).then((r) => r.data),
  /** 翻一张指定位置的公共牌（逐张点击，M3）；配额耗尽瞬间服务端生成该轮报价 */
  flip: (sessionId: number, position: number) =>
    api
      .post<{ state: PlayerView }>(`/match/${sessionId}/flip`, { position })
      .then((r) => r.data),
  deal: (sessionId: number) =>
    api.post<{ state: PlayerView }>(`/match/${sessionId}/deal`).then((r) => r.data),
  counter: (sessionId: number, counter: number) =>
    api.post<{ state: PlayerView }>(`/match/${sessionId}/counter`, { counter }).then((r) => r.data),
  noDeal: (sessionId: number) =>
    api.post<{ state: PlayerView }>(`/match/${sessionId}/no-deal`).then((r) => r.data),
  swap: (sessionId: number, swap: boolean) =>
    api.post<{ state: PlayerView }>(`/match/${sessionId}/swap`, { swap }).then((r) => r.data),
  getAmountList: (sessionId: number) =>
    api.get<AmountListView>(`/match/${sessionId}/amount-list`).then((r) => r.data),
};

/** POST /match/start 409（已有进行中对局）响应体中的 sessionId（ActiveSessionExistsError） */
export function getStartConflictSessionId(error: unknown): number | null {
  if (axios.isAxiosError(error) && error.response?.status === 409) {
    const data = error.response.data as { sessionId?: unknown } | undefined;
    if (typeof data?.sessionId === 'number' && Number.isInteger(data.sessionId)) {
      return data.sessionId;
    }
  }
  return null;
}

/** 判断是否为指定 HTTP 状态码的业务错误（如 400 余额不足/还价非法） */
export function isHttpStatus(error: unknown, status: number): boolean {
  return axios.isAxiosError(error) && error.response?.status === status;
}
