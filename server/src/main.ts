import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // REST 接口统一挂 /api 前缀（文档第六章）
  app.setGlobalPrefix('api');

  // SQLite 开启 WAL 模式（文档 2.2：默认 better-sqlite3 + WAL）
  const dataSource = app.get(DataSource);
  await dataSource.query('PRAGMA journal_mode = WAL;');

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port);
  new Logger('Bootstrap').log(`server listening on http://localhost:${port}`);
}

void bootstrap();
