import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** GET /api/health —— 存活探针（全局前缀 api 在 main.ts 注册） */
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
