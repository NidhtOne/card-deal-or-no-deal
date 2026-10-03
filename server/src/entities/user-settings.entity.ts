import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * user_settings —— 设置表（docs/开发文档.md 5.1）。
 * 默认值按 3.7：BGM 开/默认曲目/音量 60、音效开/80、面额清单开、风险提示开、成就开。
 */
@Entity('user_settings')
export class UserSettings {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', unique: true })
  userId!: number;

  /** 背景音乐开关（默认开） */
  @Column({ name: 'bgm_enabled', type: 'boolean', default: true })
  bgmEnabled!: boolean;

  /** 背景音乐曲目（默认曲目） */
  @Column({ name: 'bgm_track', default: 'default' })
  bgmTrack!: string;

  /** 音乐音量 0-100（默认 60） */
  @Column({ default: 60 })
  volume!: number;

  /** 音效开关（默认开） */
  @Column({ name: 'sfx_enabled', type: 'boolean', default: true })
  sfxEnabled!: boolean;

  /** 音效音量 0-100（默认 80） */
  @Column({ name: 'sfx_volume', default: 80 })
  sfxVolume!: number;

  /** 面额清单开关（默认开） */
  @Column({ name: 'amount_list_enabled', type: 'boolean', default: true })
  amountListEnabled!: boolean;

  /** 风险提示弹窗（默认开） */
  @Column({ name: 'risk_popup_enabled', type: 'boolean', default: true })
  riskPopupEnabled!: boolean;

  /** 成就系统开关（默认开） */
  @Column({ name: 'achievement_enabled', type: 'boolean', default: true })
  achievementEnabled!: boolean;

  /**
   * 对局历史保留天数（0=永久保留，默认 0）【文档外补充：2026-10-03 人工决策落地】。
   * DEFAULT 0 保证存量用户行为不变（永久保留）；合法值白名单 =
   * economy.json history.retention_options_days（PUT 校验，非法 400）。
   */
  @Column({ name: 'history_retention_days', default: 0 })
  historyRetentionDays!: number;
}
