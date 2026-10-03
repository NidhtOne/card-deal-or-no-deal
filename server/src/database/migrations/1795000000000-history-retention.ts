import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M8：user_settings 新增对局历史保留天数【文档外补充：2026-10-03 人工决策落地】。
 *
 * history_retention_days：0=永久保留（DEFAULT 0，保证存量用户行为不变——
 * 人工决策「保留多久由用户自行决定」上线时不改变任何既有用户的历史可见性）；
 * 合法值白名单 = economy.json history.retention_options_days，PUT /api/user/settings 校验。
 */
export class HistoryRetention1795000000000 implements MigrationInterface {
  name = 'HistoryRetention1795000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user_settings"
        ADD COLUMN "history_retention_days" integer NOT NULL DEFAULT (0)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "history_retention_days"`,
    );
  }
}
