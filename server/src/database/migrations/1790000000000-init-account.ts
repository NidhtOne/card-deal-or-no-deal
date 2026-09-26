import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 账号系统首版表结构（表名/字段名以 docs/开发文档.md 5.1 为准）：
 * users / user_profiles / user_wallets / user_settings / fund_flows。
 * 铁律 4：金额一律 INTEGER，单位「分」（覆盖 5.1 的 REAL/NUMERIC 写法）。
 * 文档外补充（均已在注释注明）：
 * - users.failed_login_attempts / users.locked_until：落实 3.1.2「连续失败 5 次锁定 15 分钟」；
 * - fund_flows.idem_key：落实 5.2「唯一约束 + 幂等键防重复发放」；
 * - refresh_tokens 整表：落实 3.1.2 Refresh Token 吊销/轮换。
 */
export class InitAccount1790000000000 implements MigrationInterface {
  name = 'InitAccount1790000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "username" text NOT NULL,
        "password_hash" text NOT NULL,
        "security_question" text NOT NULL,
        "security_answer_hash" text NOT NULL,
        "status" integer NOT NULL DEFAULT (0),
        "failed_login_attempts" integer NOT NULL DEFAULT (0),
        "locked_until" datetime,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "last_login_at" datetime
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_username" ON "users" ("username")`,
    );

    await queryRunner.query(`
      CREATE TABLE "user_profiles" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "nickname" text,
        "signature" text,
        "avatar_url" text,
        "character_url" text,
        "banker_character_url" text,
        "username_changed_at" datetime,
        CONSTRAINT "FK_user_profiles_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_profiles_user" ON "user_profiles" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "user_wallets" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "balance" integer NOT NULL DEFAULT (0),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_user_wallets_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_wallets_user" ON "user_wallets" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "user_settings" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "bgm_enabled" boolean NOT NULL DEFAULT (1),
        "bgm_track" varchar NOT NULL DEFAULT ('default'),
        "volume" integer NOT NULL DEFAULT (60),
        "sfx_enabled" boolean NOT NULL DEFAULT (1),
        "sfx_volume" integer NOT NULL DEFAULT (80),
        "amount_list_enabled" boolean NOT NULL DEFAULT (1),
        "risk_popup_enabled" boolean NOT NULL DEFAULT (1),
        "achievement_enabled" boolean NOT NULL DEFAULT (1),
        CONSTRAINT "FK_user_settings_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_settings_user" ON "user_settings" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "fund_flows" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "amount" integer NOT NULL,
        "balance_after" integer NOT NULL,
        "type" text NOT NULL,
        "ref_id" text,
        "idem_key" text,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_fund_flows_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_fund_flows_idem_key" ON "fund_flows" ("idem_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fund_flows_user_created" ON "fund_flows" ("user_id", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "token_hash" text NOT NULL,
        "expires_at" datetime NOT NULL,
        "revoked_at" datetime,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "fund_flows"`);
    await queryRunner.query(`DROP TABLE "user_settings"`);
    await queryRunner.query(`DROP TABLE "user_wallets"`);
    await queryRunner.query(`DROP TABLE "user_profiles"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
