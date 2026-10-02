import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * achievements —— 成就定义表（docs/开发文档.md 5.1：achievements / user_achievements，
 * 文档未给字段清单 —— 文档外补充）。
 * 内容为 config/economy.json achievements.list 的启动同步镜像（铁律 7：数值唯一来源
 * 是配置文件，应用启动时按 code upsert，删配置即删定义）。
 * 铁律 4：reward 一律 INTEGER，单位「分」。
 */
@Entity('achievements')
export class Achievement {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 成就代码（唯一；对齐 config/economy.json achievements.list[].code） */
  @Column({ unique: true })
  code!: string;

  @Column()
  name!: string;

  /** 奖励（分） */
  @Column()
  reward!: number;
}
