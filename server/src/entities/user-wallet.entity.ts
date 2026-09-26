import { Column, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * user_wallets —— 资金表（docs/开发文档.md 5.1）。
 * 铁律 4：balance 一律 INTEGER，单位「分」（覆盖 5.1 的 REAL/NUMERIC 写法）；
 * 所有读写走事务（铁律 1），UPDATE 带余额条件防负余额（铁律 2）。
 */
@Entity('user_wallets')
export class UserWallet {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', unique: true })
  userId!: number;

  /** 余额，单位：分 */
  @Column({ default: 0 })
  balance!: number;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
