import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * daily_tasks —— 每日任务定义表（docs/开发文档.md 5.1：task_code / reward）。
 * 内容为 config/economy.json tasks.list 的启动同步镜像（铁律 7：数值唯一来源是配置文件，
 * 应用启动时按 code upsert，删配置即删定义）。文档未定义补充列 —— 文档外补充：
 * - tier（限定档位 1–5，NULL = 任意档位，如勤奋玩家）；
 * - target（当日需完成局数，档位任务恒为 1，勤奋玩家为 3）。
 * 铁律 4：reward 一律 INTEGER，单位「分」。
 */
@Entity('daily_tasks')
export class DailyTask {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 任务代码（唯一；对齐 config/economy.json tasks.list[].code） */
  @Column({ name: 'task_code', unique: true })
  taskCode!: string;

  @Column()
  name!: string;

  /** 限定档位 1–5；NULL = 任意档位 —— 文档外补充列 */
  @Column({ type: 'integer', nullable: true })
  tier!: number | null;

  /** 当日需完成局数 —— 文档外补充列 */
  @Column({ default: 1 })
  target!: number;

  /** 奖励（分） */
  @Column()
  reward!: number;
}
