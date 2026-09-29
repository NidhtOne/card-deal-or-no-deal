import { existsSync } from 'fs';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule, ServeStaticModuleOptions } from '@nestjs/serve-static';
import { resolveFromRoot } from './config/paths';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { EventsGateway } from './events/events.gateway';
import { AuthModule } from './auth/auth.module';
import { MatchModule } from './match/match.module';
import { UserModule } from './user/user.module';

/**
 * 静态托管（文档 2.1：前端构建产物由后端直接托管）：
 * - assets/ 固定托管为 /assets/...（仅内置资产：银行家立绘、BGM、占位图）
 * - STORAGE_DIR 托管为 /uploads/...（用户上传文件，与内置资产严格区分；STORAGE_DIR 默认 ./storage）
 * - web/dist 存在时（生产模式）托管为站点根路径，/api、/ws、/assets、/uploads 不被 SPA 回退吞掉
 */
function buildServeStaticOptions(): ServeStaticModuleOptions[] {
  const options: ServeStaticModuleOptions[] = [
    {
      rootPath: resolveFromRoot('assets'),
      serveRoot: '/assets',
    },
    {
      rootPath: resolveFromRoot(process.env.STORAGE_DIR ?? './storage'),
      serveRoot: '/uploads',
    },
  ];
  const webDist = resolveFromRoot('web/dist');
  if (existsSync(webDist)) {
    options.unshift({
      rootPath: webDist,
      exclude: ['/api/(.*)', '/ws/(.*)', '/assets/(.*)', '/uploads/(.*)'],
    });
  }
  return options;
}

@Module({
  imports: [
    ServeStaticModule.forRoot(...buildServeStaticOptions()),
    DatabaseModule,
    // 进程内事件总线（match_started / match_settled 等七章.6 钩子 —— 文档外补充）
    EventEmitterModule.forRoot(),
    AuthModule,
    UserModule,
    MatchModule,
  ],
  controllers: [HealthController],
  providers: [EventsGateway],
})
export class AppModule {}
