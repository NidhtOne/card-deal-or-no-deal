import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** 报价处理结果（docs/开发文档.md 5.1 offers.result）；NULL = 待响应 */
export enum OfferResult {
  Deal = '成交',
  CounterAccepted = '还价接受',
  CounterRejected = '还价拒绝',
  Rejected = '拒绝',
  Timeout = '超时',
}

/**
 * offers —— 报价记录表（docs/开发文档.md 5.1）。
 * 文档外补充（注释标注）：
 * - id 自增主键（5.1 未列主键；同会话内 id 序即报价时间序）；
 * - round 可空：终局终极报价存 NULL（引擎事件 round=null）；
 * - k / ev_fen / counter_draw / counter_probability：浮点审计中间量，
 *   落实七章.3「所有随机判定服务端落库，保证可审计」，禁止参与金额计算。
 */
@Entity('offers')
export class Offer {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'session_id' })
  sessionId!: number;

  /** 报价轮次（1 起）；终局终极报价为 NULL */
  @Column({ type: 'integer', nullable: true })
  round!: number | null;

  /** 报价金额（分） */
  @Column({ name: 'offer_amount' })
  offerAmount!: number;

  /** 处理结果；NULL = 待响应 */
  @Column({ type: 'text', nullable: true })
  result!: OfferResult | null;

  /** 还价金额（分，如有） */
  @Column({ name: 'counter_amount', type: 'integer', nullable: true })
  counterAmount!: number | null;

  /** 报价系数（浮点审计中间量，禁止参与金额计算） */
  @Column({ type: 'real', nullable: true })
  k!: number | null;

  /** 报价时剩余卡均值（分，浮点审计中间量，禁止参与金额计算） */
  @Column({ name: 'ev_fen', type: 'real', nullable: true })
  evFen!: number | null;

  /** 还价判定抽签值（浮点审计中间量；未抽签为 NULL） */
  @Column({ name: 'counter_draw', type: 'real', nullable: true })
  counterDraw!: number | null;

  /** 还价判定接受概率（浮点审计中间量；必接受/必拒分支为 1/0） */
  @Column({ name: 'counter_probability', type: 'real', nullable: true })
  counterProbability!: number | null;
}
