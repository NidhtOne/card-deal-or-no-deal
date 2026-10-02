/**
 * 对局生命周期内部事件载荷（进程内事件总线，@nestjs/event-emitter —— 文档外补充；
 * 七章.6 钩子：对局开启记任务进度、对局结算判定盈利类成就，M4 消费）。
 * 纯类型定义，无任何 I/O。
 */

/** match_started：对局开启扣费成功（幂等回放不重复发） */
export interface MatchStartedPayload {
  userId: number;
  sessionId: number;
  /** 档位 1–5 */
  tier: number;
  /** 入场费（分） */
  entryFeeFen: number;
}

/** match_settled：对局结算完成（含超时托管结算路径，3.6.8/七章.5） */
export interface MatchSettledPayload {
  userId: number;
  sessionId: number;
  /** 档位 1–5 */
  tier: number;
  /** DB 终态：成交/终局/超时结算 */
  status: string;
  /** 是否超时托管结算 */
  timeout: boolean;
  settlement: {
    reason: 'deal' | 'counter' | 'keep' | 'swap';
    /** 税前奖金（分） */
    prizeFen: number;
    /** 单局盈利 = 税前奖金 − 入场费（分） */
    profitFen: number;
    /** 阶梯税（分） */
    taxFen: number;
    /** 实际到手（分） */
    netFen: number;
  };
  /** 实际盈亏 = 税后到手 − 入场费（分，可为负） */
  netProfitFen: number;
  /** 结算后余额（分） */
  settledBalanceFen: number;
}
