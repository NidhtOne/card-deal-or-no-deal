import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';

/** 应用公共装配（main 与集成测试共用）：全局前缀 /api + 全局 class-validator 校验 */
export function configureApp(app: INestApplication): void {
  // REST 接口统一挂 /api 前缀（文档第六章）
  app.setGlobalPrefix('api');
  // 全部接口 class-validator 校验（whitelist 剥离多余字段，transform 转换基础类型）
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  // SQLite 开启 WAL 模式（文档 2.2：默认 better-sqlite3 + WAL）
  const dataSource = app.get(DataSource);
  await dataSource.query('PRAGMA journal_mode = WAL;');

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port);
  new Logger('Bootstrap').log(`server listening on http://localhost:${port}`);
}

// 仅作为进程入口时启动（集成测试 import configureApp 不应拉起服务）
if (require.main === module) {
  void bootstrap();
}
