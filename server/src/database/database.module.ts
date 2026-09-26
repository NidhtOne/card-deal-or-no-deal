import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './data-source';

/**
 * 数据库模块：better-sqlite3（WAL 模式在 main.ts 连接建立后通过 PRAGMA 开启）。
 * migrationsRun: true —— 启动时自动执行未应用的 migration（当前为空，表结构随后续阶段加入）。
 */
@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...buildDataSourceOptions(),
      autoLoadEntities: true,
      migrationsRun: true,
    }),
  ],
})
export class DatabaseModule {}
