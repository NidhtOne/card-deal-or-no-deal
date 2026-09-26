import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** user_profiles —— 资料表（docs/开发文档.md 5.1） */
@Entity('user_profiles')
export class UserProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', unique: true })
  userId!: number;

  @Column({ type: 'text', nullable: true })
  nickname!: string | null;

  @Column({ type: 'text', nullable: true })
  signature!: string | null;

  /** 头像（用户上传） */
  @Column({ name: 'avatar_url', type: 'text', nullable: true })
  avatarUrl!: string | null;

  /** 用户角色立绘（用户上传） */
  @Column({ name: 'character_url', type: 'text', nullable: true })
  characterUrl!: string | null;

  /** 自定义银行家图（可空，空则用内置默认） */
  @Column({ name: 'banker_character_url', type: 'text', nullable: true })
  bankerCharacterUrl!: string | null;

  /** 限制改名频率（3.2：1 次/30 天） */
  @Column({ name: 'username_changed_at', type: 'datetime', nullable: true })
  usernameChangedAt!: Date | null;
}
