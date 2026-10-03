/**
 * M8-fix1【文档外补充：2026-10-03 人工决策落地】
 * user_game_state migration 存量结算记录回填推导测试。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';

jest.setTimeout(120000);

const tmpDir = mkdtempSync(join(tmpdir(), 'dond-migration-backfill-'));
process.env.DATABASE_URL = join(tmpDir, 'test.db');

/* eslint-disable @typescript-eslint/no-var-requires */
const { buildDataSourceOptions } =
  require('../src/database/data-source') as typeof import('../src/database/data-source');
const { UserGameState1794000000000 } =
  require('../src/database/migrations/1794000000000-user-game-state') as typeof import('../src/database/migrations/1794000000000-user-game-state');
/* eslint-enable @typescript-eslint/no-var-requires */

let dataSource: DataSource;
let seq = 0;

async function createUser(): Promise<number> {
  seq += 1;
  await dataSource.query(
    `INSERT INTO users (username, password_hash, security_question, security_answer_hash)
     VALUES (?, 'hash', 'question', 'answer')`,
    [`mig${seq}`],
  );
  const rows = (await dataSource.query('SELECT last_insert_rowid() AS id')) as { id: number }[];
  return Number(rows[0].id);
}

async function seedSequence(userId: number, profits: number[]): Promise<void> {
  for (let i = 0; i < profits.length; i += 1) {
    const finishedAt = `2026-01-${String(i + 1).padStart(2, '0')} 00:00:00`;
    await dataSource.query(
      `INSERT INTO game_sessions
         (user_id, tier, entry_fee, tier_max_prize, status, timeout_deadline,
          final_bonus, tax, net_profit, finished_at, state_snapshot)
       VALUES (?, 1, 38800, 388800, '成交', 0, ?, 0, ?, ?, '{}')`,
      [userId, 38800 + profits[i], profits[i], finishedAt],
    );
  }
}

beforeAll(async () => {
  dataSource = new DataSource(buildDataSourceOptions());
  await dataSource.initialize();
  await dataSource.runMigrations();
});

beforeEach(async () => {
  await dataSource.query('DELETE FROM user_game_state');
  await dataSource.query('DELETE FROM game_sessions');
  await dataSource.query('DELETE FROM users');
});

afterAll(async () => {
  await dataSource?.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function rerunBackfill(): Promise<void> {
  await dataSource.query('DROP TABLE user_game_state');
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await new UserGameState1794000000000().up(runner);
  } finally {
    await runner.release();
  }
}

async function stateOf(userId: number): Promise<Record<string, number> | undefined> {
  const rows = (await dataSource.query(
    `SELECT win_streak, streak_profit_fen, total_settled_games
     FROM user_game_state WHERE user_id = ?`,
    [userId],
  )) as Record<string, number>[];
  return rows[0];
}

describe('UserGameState1794000000000 回填', () => {
  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('最近亏损后连盈 2 局，保本段内不计入', async () => {
    const userId = await createUser();
    await seedSequence(userId, [100, 200, 0, 300, -50, 400, 500]);
    await rerunBackfill();

    expect(await stateOf(userId)).toMatchObject({
      win_streak: 2,
      streak_profit_fen: 900,
      total_settled_games: 7,
    });
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('全历史无亏损时整段为当前段', async () => {
    const userId = await createUser();
    await seedSequence(userId, [100, 0, 200]);
    await rerunBackfill();

    expect(await stateOf(userId)).toMatchObject({
      win_streak: 2,
      streak_profit_fen: 300,
      total_settled_games: 3,
    });
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('全保本回填为零连胜、零累计利润', async () => {
    const userId = await createUser();
    await seedSequence(userId, [0, 0]);
    await rerunBackfill();

    expect(await stateOf(userId)).toMatchObject({
      win_streak: 0,
      streak_profit_fen: 0,
      total_settled_games: 2,
    });
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('最后一局为亏损时当前连胜段清零', async () => {
    const userId = await createUser();
    await seedSequence(userId, [100, 200, -50]);
    await rerunBackfill();

    expect(await stateOf(userId)).toMatchObject({
      win_streak: 0,
      streak_profit_fen: 0,
      total_settled_games: 3,
    });
  });

  // M8-fix1【文档外补充：2026-10-03 人工决策落地】
  it('无任何 session 的用户不产生状态行', async () => {
    const userId = await createUser();
    await rerunBackfill();

    expect(await stateOf(userId)).toBeUndefined();
    const rows = (await dataSource.query(
      'SELECT COUNT(*) AS count FROM user_game_state',
    )) as { count: number }[];
    expect(Number(rows[0].count)).toBe(0);
  });
});
