import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** 资金流水类型（docs/开发文档.md 5.1 fund_flows.type） */
export enum FundFlowType {
  Initial = '初始赠送',
  Entry = '入场',
  Bonus = '奖金',
  Tax = '税',
  Signin = '签到',
  Task = '任务',
  Bailout = '救助',
  Achievement = '成就',
}

/**
 * fund_flows —— 资金流水（审计）表（docs/开发文档.md 5.1）。
 * 铁律 4：amount / balance_after 一律 INTEGER，单位「分」。
 * idem_key：落实 5.2「唯一约束 + 幂等键防重复发放」，5.1 未定义 —— 文档外补充。
 */
@Entity('fund_flows')
export class FundFlow {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id' })
  userId!: number;

  /** 变动金额（正入负出），单位：分 */
  @Column()
  amount!: number;

  /** 变动后余额，单位：分 */
  @Column({ name: 'balance_after' })
  balanceAfter!: number;

  @Column({ type: 'text' })
  type!: FundFlowType;

  /** 关联对局/任务/成就 ID */
  @Column({ name: 'ref_id', type: 'text', nullable: true })
  refId!: string | null;

  /** 幂等键，唯一约束防重复发放 —— 文档外补充 */
  @Column({ name: 'idem_key', type: 'text', unique: true, nullable: true })
  idemKey!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
