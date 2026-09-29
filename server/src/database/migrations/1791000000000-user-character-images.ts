import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 用户角色立绘历史表（docs/开发文档.md 5.1 未定义 —— 文档外补充，
 * 落实 3.3「保留最近 3 张历史图供切换」；FK CASCADE 随账号注销级联删除）。
 */
export class UserCharacterImages1791000000000 implements MigrationInterface {
  name = 'UserCharacterImages1791000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_character_images" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "user_id" integer NOT NULL,
        "url" text NOT NULL,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "FK_user_character_images_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_user_character_images_user_created" ON "user_character_images" ("user_id", "created_at")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_character_images"`);
  }
}
