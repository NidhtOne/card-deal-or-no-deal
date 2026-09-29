import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 对局状态（docs/开发文档.md 5.1 game_sessions.status：进行/成交/终局/超时结算） */
export enum GameSessionStatus {
  Playing = '进行',
  Deal = '成交',
  Final = '终局',
  Timeout = '超时结算',
}

/**
 * game_sessions —— 对局表（docs/开发文档.md 5.1）。
 * 无独立历史表：本表即对决历史（5.2 的 (user_id, finished_at) 索引为证），
 * 「写历史」= 更新结算字段 + finished_at。
 * 铁律 4：金额一律 INTEGER，单位「分」。
 * 文档外补充（注释标注）：
 * - own_card_id 存牌位 0–25（5.1 未定义取值语义，决策为 position）；
 * - timeout_deadline 存 INTEGER 毫秒 epoch（5.1 未定义类型，决策便于注入时钟判定）；
 * - state_snapshot：引擎 getState() JSON。含 seed/rngState/poolFen，属服务端机密，
 *   禁止进入任何 API 响应。
 */
@Entity('game_sessions')
@Index('IDX_game_sessions_user_status', ['userId', 'status'])
@Index('IDX_game_sessions_user_finished', ['userId', 'finishedAt'])
export class GameSession {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id' })
  userId!: number;

  /**
   * 档位 1–5（文档 5.1）。与引擎 tierId 映射（server 侧常量，见 match/tier-map.ts）：
   * 1=atm 2=beginner 3=standard 4=advanced 5=master
   */
  @Column()
  tier!: number;

  /** 入场费开局快照（分） */
  @Column({ name: 'entry_fee' })
  entryFee!: number;

  /** 档位单局最高奖金开局快照（分） */
  @Column({ name: 'tier_max_prize' })
  tierMaxPrize!: number;

  @Column({ type: 'text' })
  status!: GameSessionStatus;

  /** 玩家底牌牌位 0–25（未选为 NULL） */
  @Column({ name: 'own_card_id', type: 'integer', nullable: true })
  ownCardId!: number | null;

  /** 当前轮次（1 起；未进轮次为 0） */
  @Column({ name: 'current_round', default: 0 })
  currentRound!: number;

  /** 本轮待翻张数（仅翻牌态有意义，其余为 0） */
  @Column({ name: 'flip_quota', default: 0 })
  flipQuota!: number;

  /** 当前银行家报价（分），无待响应报价时为 NULL */
  @Column({ name: 'current_offer', type: 'integer', nullable: true })
  currentOffer!: number | null;

  /** 本轮是否已还价（3.6.5 每轮限 1 次） */
  @Column({ name: 'counter_used_round', type: 'boolean', default: false })
  counterUsedRound!: boolean;

  /** 5 分钟超时截止（毫秒 epoch） */
  @Column({ name: 'timeout_deadline' })
  timeoutDeadline!: number;

  /** 税前奖金（分，结算后写入） */
  @Column({ name: 'final_bonus', type: 'integer', nullable: true })
  finalBonus!: number | null;

  /** 阶梯税（分，结算后写入） */
  @Column({ name: 'tax', type: 'integer', nullable: true })
  tax!: number | null;

  /** 实际盈亏 = 税后到手 − 入场费（分，可为负） */
  @Column({ name: 'net_profit', type: 'integer', nullable: true })
  netProfit!: number | null;

  /** 税后入账后的余额快照（分） */
  @Column({ name: 'settled_balance', type: 'integer', nullable: true })
  settledBalance!: number | null;

  /** 引擎 getState() JSON（文档外补充；服务端机密，禁止进入任何 API 响应） */
  @Column({ name: 'state_snapshot', type: 'text' })
  stateSnapshot!: string;

  @CreateDateColumn({ name: 'started_at' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'datetime', nullable: true })
  finishedAt!: Date | null;
}
