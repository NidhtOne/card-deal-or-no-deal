import { api } from './client';

/**
 * 对决历史 REST 客户端（M5 阶段 7：docs/开发文档.md 3.10 / 6.3 / 第四章 /history）。
 * 契约唯一来源：server/src/history/history.service.ts（响应体字段逐字段对齐）；
 * 金额一律整数分（铁律 4），展示层统一走 utils/money 分→元。
 */

/** 结果筛选枚举【文档外补充：3.10 只有中文标签「盈利/亏损/保本」，接口枚举由服务端钦定】 */
export type HistoryResultFilter = 'profit' | 'loss' | 'even';

/** 单条历史记录（3.10 逐字 7 字段 + sessionId 行标识【文档外补充】） */
export interface HistoryItem {
  sessionId: number;
  /** 对局时间（精确到分钟，YYYY-MM-DD HH:mm） */
  matchedAt: string;
  /** 档位 1–5 */
  tier: number;
  /** 入场消耗（分） */
  entryFeeFen: number;
  /** 结果：成交离场 / 终局开牌（映射钦定：超时托管归入终局开牌） */
  outcome: '成交离场' | '终局开牌';
  /** 最终报价或开牌奖金（分） */
  finalAmountFen: number;
  /** 税额（分；亏损局为 0） */
  taxFen: number;
  /** 实际盈亏（分；= 到手 − 入场费，可为负） */
  netProfitFen: number;
}

export interface HistoryList {
  items: HistoryItem[];
  page: number;
  /** 钦定 20【文档未定义 → 文档外补充】 */
  pageSize: number;
  total: number;
  totalPages: number;
}

/** GET /api/history/stats 统计面板（3.10 六项） */
export interface HistoryStats {
  /** 累计对局数（完赛口径，含托管局） */
  totalMatches: number;
  /** 累计净盈亏（分；与 3.2「总盈亏」同源） */
  totalNetProfitFen: number;
  /** 总体胜率（0-1；盈利局/完赛总局，保本入分母不算胜） */
  winRate: number;
  /** 单局最高盈利（分） */
  maxNetProfitFen: number;
  /** 各档位参与分布（1–5 全列，含 0） */
  tierDistribution: { tier: number; count: number }[];
  /** 累计交税总额（分） */
  totalTaxFen: number;
}

export const historyApi = {
  list: (params: { tier?: number; result?: HistoryResultFilter; page?: number }) =>
    api
      .get<HistoryList>('/history', {
        params: {
          ...(params.tier !== undefined ? { tier: params.tier } : {}),
          ...(params.result !== undefined ? { result: params.result } : {}),
          ...(params.page !== undefined && params.page !== 1 ? { page: params.page } : {}),
        },
      })
      .then((r) => r.data),
  stats: () => api.get<HistoryStats>('/history/stats').then((r) => r.data),
};
