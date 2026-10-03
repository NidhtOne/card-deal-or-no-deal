import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M8：用户对局累计状态表 + user_settings 历史保留天数【文档外补充：2026-10-03 人工决策落地】。
 *
 * 表与全部字段均为文档外新增：
 * - user_game_state：连胜盈利冻结机制（win_streak_guard）的持久化状态，同时作为成就判定
 *   与 game_sessions 物理清理解耦后的计数器来源（连胜猎手/初出茅庐/勤劳玩家改读本表）；
 * - 回填：为存量用户按现有 game_sessions 一次性推导 win_streak / streak_profit_fen /
 *   total_settled_games（口径与 M4 口径 d 一致：保本不中断不计入、亏损清零、含托管局），
 *   避免升级后成就计数清零；
 * - guard_frozen / guard_triggered_at 不回填（新机制上线时无存量冻结状态，默认 0/NULL）。
 */
export class UserGameState1794000000000 implements MigrationInterface {
  name = 'UserGameState1794000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_game_state" (
        "user_id" integer PRIMARY KEY NOT NULL,
        "win_streak" integer NOT NULL DEFAULT (0),
        "streak_profit_fen" integer NOT NULL DEFAULT (0),
        "guard_frozen" integer NOT NULL DEFAULT (0),
        "guard_triggered_at" integer,
        "total_settled_games" integer NOT NULL DEFAULT (0),
        CONSTRAINT "FK_user_game_state_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_user_game_state_user" ON "user_game_state" ("user_id")`,
    );

    // 回填（文档外补充）：按 (finished_at, id) 倒序给已结算局编号 rn（新→旧），
    // last_loss_rn = 最近一局亏损（net_profit < 0）的编号（无亏损为 0）。
    // 当前连胜段 = 编号严格小于 last_loss_rn 的全部行（即最近一次亏损之后的局，
    // 保本局落在段内但不计入局数、也不产生利润），与运行期计数器口径完全一致：
    //   盈利 → win_streak+1、streak_profit+=net_profit；保本 → 两者不变；亏损 → 清零。
    // total_settled_games = 全部已结算局数（finished_at 非空即计数，含超时托管局）。
    await queryRunner.query(`
      INSERT INTO "user_game_state"
        ("user_id", "win_streak", "streak_profit_fen", "guard_frozen", "guard_triggered_at", "total_settled_games")
      SELECT
        t.user_id,
        COALESCE(s.win_streak, 0),
        COALESCE(s.streak_profit_fen, 0),
        0,
        NULL,
        t.total_games
      FROM (
        SELECT user_id, COUNT(*) AS total_games
        FROM "game_sessions"
        WHERE finished_at IS NOT NULL
        GROUP BY user_id
      ) t
      LEFT JOIN (
        SELECT user_id,
               SUM(CASE WHEN net_profit > 0 THEN 1 ELSE 0 END) AS win_streak,
               SUM(CASE WHEN net_profit > 0 THEN net_profit ELSE 0 END) AS streak_profit_fen
        FROM (
          SELECT
            x.user_id,
            x.net_profit,
            x.rn,
            MAX(CASE WHEN x.net_profit < 0 THEN x.rn ELSE 0 END)
              OVER (PARTITION BY x.user_id) AS last_loss_rn
          FROM (
            SELECT
              user_id,
              net_profit,
              ROW_NUMBER() OVER (
                PARTITION BY user_id
                ORDER BY finished_at DESC, id DESC
              ) AS rn
            FROM "game_sessions"
            WHERE finished_at IS NOT NULL
          ) x
        ) y
        WHERE y.rn < y.last_loss_rn OR y.last_loss_rn = 0
        GROUP BY user_id
      ) s ON s.user_id = t.user_id
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_game_state"`);
  }
}
