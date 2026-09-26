import { existsSync } from 'fs';
import { Module } from '@nestjs/common';
import { ServeStaticModule, ServeStaticModuleOptions } from '@nestjs/serve-static';
import { resolveFromRoot } from './config/paths';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { EventsGateway } from './events/events.gateway';

/**
 * 静态托管（文档 2.1：前端构建产物由后端直接托管）：
 * - assets/ 固定托管为 /assets/...（银行家立绘、BGM、占位图）
 * - web/dist 存在时（生产模式）托管为站点根路径，/api、/ws、/assets 不被 SPA 回退吞掉
 */
function buildServeStaticOptions(): ServeStaticModuleOptions[] {
  const options: ServeStaticModuleOptions[] = [
    {
      rootPath: resolveFromRoot('assets'),
      serveRoot: '/assets',
    },
  ];
  const webDist = resolveFromRoot('web/dist');
  if (existsSync(webDist)) {
    options.unshift({
      rootPath: webDist,
      exclude: ['/api/(.*)', '/ws/(.*)', '/assets/(.*)'],
    });
  }
  return options;
}

@Module({
  imports: [ServeStaticModule.forRoot(...buildServeStaticOptions()), DatabaseModule],
  controllers: [HealthController],
  providers: [EventsGateway],
})
export class AppModule {}
