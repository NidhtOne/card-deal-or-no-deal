import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** 账号状态（docs/开发文档.md 5.1：正常/锁定/注销） */
export const USER_STATUS = {
  NORMAL: 0,
  LOCKED: 1,
  CANCELLED: 2,
} as const;

/**
 * users —— 账号表（表名/字段名以 docs/开发文档.md 5.1 为准）。
 * failed_login_attempts / locked_until：为落实 3.1.2「连续失败 5 次锁定 15 分钟」所需，
 * 5.1 未定义 —— 文档外补充。
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  username!: string;

  /** bcrypt 哈希 */
  @Column({ name: 'password_hash' })
  passwordHash!: string;

  @Column({ name: 'security_question' })
  securityQuestion!: string;

  /** 密保答案 bcrypt 哈希 */
  @Column({ name: 'security_answer_hash' })
  securityAnswerHash!: string;

  /** 0=正常 1=锁定 2=注销（3.1.2 的临时锁定走 locked_until，不改写 status） */
  @Column({ default: USER_STATUS.NORMAL })
  status!: number;

  /** 连续登录失败次数（登录成功清零）—— 文档外补充 */
  @Column({ name: 'failed_login_attempts', default: 0 })
  failedLoginAttempts!: number;

  /** 锁定截止时间，空为未锁定 —— 文档外补充 */
  @Column({ name: 'locked_until', type: 'datetime', nullable: true })
  lockedUntil!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'last_login_at', type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;
}
