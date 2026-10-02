import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * user_task_progress —— 用户每日任务进度（docs/开发文档.md 5.1）。
 * 唯一约束 (user_id, task, date) 按 5.1 钦定实现为 (user_id, task_id, task_date)；
 * claimed 领奖标志（5.1 钦定）+ fund_flows.idem_key 双保险保证领取幂等。
 * 【钦定口径，以七章.6 为准，注释标注】3.8.3 表写勤奋玩家「当日累计完成任意 3 局」，
 * 七章.6 写「对局开启（扣费成功）即记档位任务与勤奋玩家进度」——全任务（含勤奋玩家）
 * 统一在 match_started（对局开启扣费成功）时计数；本游戏无弃权，参加=完成无差异。
 * task_date 为服务器本地日期字符串 YYYY-MM-DD（00:00 刷新后未领取失效，不补发）。
 */
@Entity('user_task_progress')
@Unique('UQ_user_task_progress_user_task_date', ['userId', 'taskId', 'taskDate'])
@Index('IDX_user_task_progress_user_date', ['userId', 'taskDate'])
export class UserTaskProgress {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id' })
  userId!: number;

  @Column({ name: 'task_id' })
  taskId!: number;

  /** 任务日期（服务器本地日期，YYYY-MM-DD） */
  @Column({ name: 'task_date' })
  taskDate!: string;

  /** 当日累计进度（局数） */
  @Column({ default: 0 })
  progress!: number;

  /** 奖励是否已领取（幂等标志） */
  @Column({ type: 'boolean', default: false })
  claimed!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
