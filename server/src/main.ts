import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';

/**
 * 应用公共装配（main 与集成测试共用）：全局前缀 /api + 全局 class-validator 校验 +
 * SQLite WAL/busy_timeout。
 * 仅此一处连接 pragmas（e2e 与生产共用本入口，禁止另设第二处）：
 * - WAL（文档 2.2：默认 better-sqlite3 + WAL）；
 * - busy_timeout=5000：better-sqlite3 默认 0（写锁冲突立即抛 SQLITE_BUSY）。
 *   多进程共库场景（如 jest 多 worker 并发起服、运维期同时跑脚本与服务）下，
 *   写锁短暂排队等待而非直接报错 —— 防御性兑底；单进程内一切写事务已由
 *   common/transaction.ts 全局 FIFO 互斥串行化，不依赖此参数。
 */
export async function configureApp(app: INestApplication): Promise<void> {
  // REST 接口统一挂 /api 前缀（文档第六章）
  app.setGlobalPrefix('api');
  // 全部接口 class-validator 校验（whitelist 剥离多余字段，transform 转换基础类型）
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const dataSource = app.get(DataSource);
  await dataSource.query('PRAGMA journal_mode = WAL;');
  await dataSource.query('PRAGMA busy_timeout = 5000;');
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await configureApp(app);

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port);
  new Logger('Bootstrap').log(`server listening on http://localhost:${port}`);
}

// 仅作为进程入口时启动（集成测试 import configureApp 不应拉起服务）
if (require.main === module) {
  void bootstrap();
}
