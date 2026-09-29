import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M2 对局表结构（表名/字段名以 docs/开发文档.md 5.1/5.2 为准）：
 * game_sessions / game_cards / offers。
 * 铁律 4：金额一律 INTEGER，单位「分」。
 * 无独立历史表：game_sessions 即对决历史（5.2 的 (user_id, finished_at) 索引为证）。
 * 文档外补充列（实体注释已标注）：game_sessions.state_snapshot、offers.id 主键、
 * offers.k / ev_fen / counter_draw / counter_probability（浮点审计中间量）。
 */
export class MatchTables1792000000000 implements MigrationInterface {
  name = 'MatchTables1792000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "game_sessions" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "tier" integer NOT NULL,
        "entry_fee" integer NOT NULL,
        "tier_max_prize" integer NOT NULL,
        "status" text NOT NULL,
        "own_card_id" integer,
        "current_round" integer NOT NULL DEFAULT (0),
        "flip_quota" integer NOT NULL DEFAULT (0),
        "current_offer" integer,
        "counter_used_round" boolean NOT NULL DEFAULT (0),
        "timeout_deadline" integer NOT NULL,
        "final_bonus" integer,
        "tax" integer,
        "net_profit" integer,
        "settled_balance" integer,
        "state_snapshot" text NOT NULL,
        "started_at" datetime NOT NULL DEFAULT (datetime('now')),
        "finished_at" datetime,
        CONSTRAINT "FK_game_sessions_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    // 5.2：进行中对局恢复索引 + 历史查询索引
    await queryRunner.query(
      `CREATE INDEX "IDX_game_sessions_user_status" ON "game_sessions" ("user_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_game_sessions_user_finished" ON "game_sessions" ("user_id", "finished_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "game_cards" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "session_id" integer NOT NULL,
        "position" integer NOT NULL,
        "amount" integer NOT NULL,
        "state" text NOT NULL,
        "flipped_at" datetime,
        CONSTRAINT "FK_game_cards_session" FOREIGN KEY ("session_id")
          REFERENCES "game_sessions" ("id") ON DELETE CASCADE
      )
    `);
    // 5.2：game_cards(session_id, position) 唯一索引
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_game_cards_session_position" ON "game_cards" ("session_id", "position")`,
    );

    await queryRunner.query(`
      CREATE TABLE "offers" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "session_id" integer NOT NULL,
        "round" integer,
        "offer_amount" integer NOT NULL,
        "result" text,
        "counter_amount" integer,
        "k" real,
        "ev_fen" real,
        "counter_draw" real,
        "counter_probability" real,
        CONSTRAINT "FK_offers_session" FOREIGN KEY ("session_id")
          REFERENCES "game_sessions" ("id") ON DELETE CASCADE
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "offers"`);
    await queryRunner.query(`DROP TABLE "game_cards"`);
    await queryRunner.query(`DROP TABLE "game_sessions"`);
  }
}
