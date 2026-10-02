import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * bailout_records —— 破产救助记录（docs/开发文档.md 5.1：user_id / apply_date / times，每日次数 00:00 重置）。
 * 语义决策（文档未定义行粒度 —— 文档外补充，注释标注）：第 n 次申请独立一行，
 * (user_id, apply_date, nth) 唯一；apply_date 为服务器本地日期 YYYY-MM-DD；
 * 「每日最多 3 次」= 当日 COUNT < max_per_day。逐行账本式记录便于审计与
 * 「第 2、3 次弹提醒」（3.8.4）定位。
 */
@Entity('bailout_records')
@Unique('UQ_bailout_records_user_date_nth', ['userId', 'applyDate', 'nth'])
@Index('IDX_bailout_records_user_date', ['userId', 'applyDate'])
export class BailoutRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id' })
  userId!: number;

  /** 申请日（服务器本地日期，YYYY-MM-DD；00:00 重置计数） */
  @Column({ name: 'apply_date' })
  applyDate!: string;

  /** 当日第几次申请（1 起） */
  @Column()
  nth!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
