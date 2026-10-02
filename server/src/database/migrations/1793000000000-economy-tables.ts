import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M4 经济系统表结构（docs/开发文档.md 5.1/5.2）：
 * daily_signins / daily_tasks / user_task_progress / bailout_records / achievements / user_achievements。
 * 铁律 4：金额一律 INTEGER，单位「分」。
 * 文档钦定约束：(user_id, sign_date) 唯一、(user_id, task, date) 唯一、claimed 标志、bailout 每日次数。
 * 文档外补充（实体注释已标注）：
 * - sign_date / task_date / apply_date 存服务器本地日期字符串 YYYY-MM-DD；
 * - daily_tasks / achievements 为 config/economy.json 启动同步镜像，含补充列 tier / target；
 * - bailout_records 按「第 n 次申请一行」记录，(user_id, apply_date, nth) 唯一；
 * - achievements/user_achievements 字段文档未给清单：code / name / reward / unlocked_at / claimed。
 */
export class EconomyTables1793000000000 implements MigrationInterface {
  name = 'EconomyTables1793000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "daily_signins" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "sign_date" text NOT NULL,
        "streak_days" integer NOT NULL,
        "reward" integer NOT NULL,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_daily_signins_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    // 5.1 钦定唯一约束 (user_id, sign_date) —— 签到幂等依据
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_daily_signins_user_date" ON "daily_signins" ("user_id", "sign_date")`,
    );

    await queryRunner.query(`
      CREATE TABLE "daily_tasks" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "task_code" text NOT NULL,
        "name" text NOT NULL,
        "tier" integer,
        "target" integer NOT NULL DEFAULT (1),
        "reward" integer NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_daily_tasks_code" ON "daily_tasks" ("task_code")`,
    );

    await queryRunner.query(`
      CREATE TABLE "user_task_progress" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "task_id" integer NOT NULL,
        "task_date" text NOT NULL,
        "progress" integer NOT NULL DEFAULT (0),
        "claimed" boolean NOT NULL DEFAULT (0),
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_user_task_progress_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_task_progress_task" FOREIGN KEY ("task_id")
          REFERENCES "daily_tasks" ("id") ON DELETE CASCADE
      )
    `);
    // 5.1 钦定唯一约束 (user_id, task, date)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_task_progress_user_task_date" ON "user_task_progress" ("user_id", "task_id", "task_date")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_task_progress_user_date" ON "user_task_progress" ("user_id", "task_date")`,
    );

    await queryRunner.query(`
      CREATE TABLE "bailout_records" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "apply_date" text NOT NULL,
        "nth" integer NOT NULL,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_bailout_records_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    // 文档外补充：第 n 次申请一行，(user_id, apply_date, nth) 唯一
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_bailout_records_user_date_nth" ON "bailout_records" ("user_id", "apply_date", "nth")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bailout_records_user_date" ON "bailout_records" ("user_id", "apply_date")`,
    );

    await queryRunner.query(`
      CREATE TABLE "achievements" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "code" text NOT NULL,
        "name" text NOT NULL,
        "reward" integer NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_achievements_code" ON "achievements" ("code")`,
    );

    await queryRunner.query(`
      CREATE TABLE "user_achievements" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "achievement_id" integer NOT NULL,
        "unlocked_at" datetime NOT NULL,
        "claimed" boolean NOT NULL DEFAULT (0),
        CONSTRAINT "FK_user_achievements_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_achievements_achievement" FOREIGN KEY ("achievement_id")
          REFERENCES "achievements" ("id") ON DELETE CASCADE
      )
    `);
    // 3.8.5 一次性解锁语义的数据库兜底（文档外补充）
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_achievements_user_achievement" ON "user_achievements" ("user_id", "achievement_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_achievements_user" ON "user_achievements" ("user_id")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_achievements"`);
    await queryRunner.query(`DROP TABLE "achievements"`);
    await queryRunner.query(`DROP TABLE "bailout_records"`);
    await queryRunner.query(`DROP TABLE "user_task_progress"`);
    await queryRunner.query(`DROP TABLE "daily_tasks"`);
    await queryRunner.query(`DROP TABLE "daily_signins"`);
  }
}
