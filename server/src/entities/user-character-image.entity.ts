import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * user_character_images —— 用户角色立绘历史表。
 * docs/开发文档.md 5.1 未定义 —— 文档外补充（落实 3.3「保留最近 3 张历史图供切换」）。
 * user_profiles.character_url 始终指向当前生效图；本表保存最近 3 张历史记录。
 */
@Entity('user_character_images')
export class UserCharacterImage {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id' })
  userId!: number;

  /** 立绘 URL（/uploads/characters/... 前缀） */
  @Column({ type: 'text' })
  url!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
