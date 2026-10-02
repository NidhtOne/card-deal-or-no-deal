import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthUserPayload, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AchievementsService } from './achievements.service';
import { BailoutService } from './bailout.service';
import { SigninService } from './signin.service';
import { TasksService } from './tasks.service';

/**
 * 经济系统 REST（M4 第一期：docs/开发文档.md 6.3 签到/任务/救助/成就）。
 * 路径与 6.3 逐字一致。/api/achievements/:id/claim 为文档外补充（service 注释标注）。
 * :id 统一为业务 code（任务/成就定义代码，字符串），避免暴露内部自增 id。
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class EconomyController {
  constructor(
    private readonly signinService: SigninService,
    private readonly tasksService: TasksService,
    private readonly bailoutService: BailoutService,
    private readonly achievementsService: AchievementsService,
  ) {}

  /** POST /api/signin —— 每日签到（幂等；重复提交返回已签到与既有奖励） */
  @Post('signin')
  signin(@CurrentUser() user: AuthUserPayload) {
    return this.signinService.signin(user.userId);
  }

  /** GET /api/tasks —— 当日任务列表（进度 + 可领取状态） */
  @Get('tasks')
  tasks(@CurrentUser() user: AuthUserPayload) {
    return this.tasksService.list(user.userId);
  }

  /** POST /api/tasks/:id/claim —— 领奖（:id = 任务 code；幂等；task_date ≠ 今日一律拒绝） */
  @Post('tasks/:id/claim')
  claimTask(@CurrentUser() user: AuthUserPayload, @Param('id') code: string) {
    return this.tasksService.claim(user.userId, code);
  }

  /** POST /api/bailout —— 破产救助（校验余额门槛、进行中对局、每日次数） */
  @Post('bailout')
  bailout(@CurrentUser() user: AuthUserPayload) {
    return this.bailoutService.apply(user.userId);
  }

  /** GET /api/achievements —— 成就列表（已领取/待领取/未解锁 + 总开关） */
  @Get('achievements')
  achievements(@CurrentUser() user: AuthUserPayload) {
    return this.achievementsService.list(user.userId);
  }

  /**
   * POST /api/achievements/:id/claim —— 领取成就奖励
   * （文档 6.3 未列此接口 —— 文档外补充，注释标注；:id = 成就 code；幂等）
   */
  @Post('achievements/:id/claim')
  claimAchievement(@CurrentUser() user: AuthUserPayload, @Param('id') code: string) {
    return this.achievementsService.claim(user.userId, code);
  }
}
