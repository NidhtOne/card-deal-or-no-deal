import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * daily_signins —— 每日签到（docs/开发文档.md 5.1）。
 * (user_id, sign_date) 唯一约束（5.1 钦定），该约束即幂等依据：重复签到命中后按已有记录返回。
 * sign_date 为服务器本地日期字符串 YYYY-MM-DD（5.1 未定义类型 —— 文档外补充，
 * 便于 00:00 重置与 interval 查询，配合注入时钟断言跨天）。
 * 铁律 4：reward 一律 INTEGER，单位「分」。
 */
@Entity('daily_signins')
@Unique('UQ_daily_signins_user_date', ['userId', 'signDate'])
export class DailySignin {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id' })
  userId!: number;

  /** 签到日（服务器本地日期，YYYY-MM-DD） */
  @Column({ name: 'sign_date' })
  signDate!: string;

  /** 当日连续签到天数（签到后口径：昨日已签则昨日 streak+1，否则 1） */
  @Column({ name: 'streak_days' })
  streakDays!: number;

  /** 实发奖励（分，= 基数 × 连签倍数，整数运算） */
  @Column()
  reward!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
