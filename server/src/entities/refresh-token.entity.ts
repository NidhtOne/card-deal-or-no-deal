import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * refresh_tokens —— Refresh Token 表（5.1 未定义 —— 文档外补充）。
 * 为落实 3.1.2「Refresh Token 可吊销/轮换」：仅保存 token 的 SHA-256 哈希，
 * 吊销时写 revoked_at；有效期差异（14 天 / 记住我 30 天）由 expires_at - created_at 体现。
 */
@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id' })
  userId!: number;

  /** Refresh Token 的 SHA-256 哈希（不落明文） */
  @Column({ name: 'token_hash', unique: true })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt!: Date;

  /** 吊销时间，空为有效 */
  @Column({ name: 'revoked_at', type: 'datetime', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
