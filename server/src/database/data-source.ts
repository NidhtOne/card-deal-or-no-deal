import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { REPO_ROOT, resolveFromRoot } from '../config/paths';

// 密钥/路径只从仓库根 .env 读取（AGENTS.md 铁律 5）；.env 缺失时全部走默认值
dotenv.config({ path: join(REPO_ROOT, '.env') });

/**
 * 组装 TypeORM 连接配置（Nest 运行时与 typeorm CLI/migration 共用同一份）。
 * DATABASE_URL 默认为 ./data/game.db，相对路径基于仓库根目录解析。
 */
export function buildDataSourceOptions(): DataSourceOptions {
  const database = resolveFromRoot(process.env.DATABASE_URL ?? './data/game.db');
  // SQLite 文件所在目录可能不存在（如首次启动），此处兜底创建
  mkdirSync(dirname(database), { recursive: true });
  return {
    type: 'better-sqlite3',
    database,
    entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    // 表结构变更一律走 migration，禁止 synchronize（文档第五章为准）
    synchronize: false,
  };
}

/** 供 typeorm CLI（migration:generate / run / revert）使用的 DataSource */
export const AppDataSource = new DataSource(buildDataSourceOptions());
