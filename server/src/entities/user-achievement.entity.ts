import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * user_achievements —— 用户成就解锁记录（docs/开发文档.md 5.1，3.8.5：一次性解锁）。
 * (user_id, achievement_id) 唯一（文档未定义约束 —— 文档外补充，一次性解锁语义的数据库兜底）。
 * 存在行即「已解锁（待领取/已领取）」；claimed = 奖励是否已领取。
 * 【钦定口径，注释标注】user_settings.achievement_enabled = off 时仅不弹窗/不展示，
 * 后台解锁与待领取记录照常累计，重新开启后可见（防止一次性成就永久错过）——文档未定义。
 */
@Entity('user_achievements')
@Unique('UQ_user_achievements_user_achievement', ['userId', 'achievementId'])
@Index('IDX_user_achievements_user', ['userId'])
export class UserAchievement {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id' })
  userId!: number;

  @Column({ name: 'achievement_id' })
  achievementId!: number;

  /** 解锁时间（注入时钟落库） */
  @Column({ name: 'unlocked_at', type: 'datetime' })
  unlockedAt!: Date;

  /** 奖励是否已领取（幂等标志） */
  @Column({ type: 'boolean', default: false })
  claimed!: boolean;
}
