import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { localDateOf } from '../common/local-date';
import { runInTransaction } from '../common/transaction';
import { getEconomyExt, type TaskDefConfig } from '../config/economy';
import { getGameRawConfigs } from '../config/game-config';
import { DailyTask } from '../entities/daily-task.entity';
import { FundFlow, FundFlowType } from '../entities/fund-flow.entity';
import { UserTaskProgress } from '../entities/user-task-progress.entity';
import { parseTiersConfig } from '../game-engine';
import { CLOCK, type Clock } from '../match/clock';
import type { MatchStartedPayload } from '../match/match-events';
import { tierIdByInt } from '../match/tier-map';
import { WalletService } from '../wallet/wallet.service';

/** 带启动同步行 id 的任务定义（daily_tasks 为 economy.json 镜像，见 syncTaskDefs） */
interface ResolvedTaskDef extends TaskDefConfig {
  id: number;
}

/** GET /api/tasks 任务项（文档 6.3 未定义响应体 —— 文档外补充；金额一律整数分） */
export interface TaskItemView {
  /** 任务代码（领奖路径参数 :id = code，见 controller 注释） */
  code: string;
  name: string;
  /** 任务要求文案（服务端组装，铁律 7 延伸：档位名称/数值禁止前端硬编码） */
  requirement: string;
  /** 限定档位 1–5；null = 任意档位 */
  tier: number | null;
  target: number;
  /** 奖励（分） */
  rewardFen: number;
  /** 当日进度（对局开启扣费成功即 +1，七章.6 钦定口径） */
  progress: number;
  /** 进度自动判定满足（progress ≥ target） */
  completed: boolean;
  /** 奖励已领取 */
  claimed: boolean;
  /** 可领取 = completed && !claimed */
  claimable: boolean;
}

export interface TasksView {
  /** 任务日期（服务器本地日期 YYYY-MM-DD；明日 00:00 刷新后未领取失效，不补发） */
  date: string;
  tasks: TaskItemView[];
}

export interface ClaimTaskView {
  code: string;
  /** 奖励（分） */
  rewardFen: number;
  /** 领取后余额（分） */
  balanceFen: number;
  /** 幂等回放 = true（重复领奖返回已领取，不再产生第二条流水） */
  alreadyClaimed: boolean;
}

/**
 * 每日任务（docs/开发文档.md 3.8.3 + 七章.6）：
 * - daily_tasks 定义 = config/economy.json tasks.list 启动同步镜像（铁律 7）；
 * - 【钦定口径，以七章.6 为准】3.8.3 表写勤奋玩家「当日累计完成任意 3 局」与
 *   七章.6「对局开启（扣费成功）即记档位任务与勤奋玩家进度」冲突 —— 全任务（含勤奋玩家）
 *   统一在 match_started（对局开启扣费成功）时计数；本游戏无弃权，参加=完成无差异；
 * - 进度实时更新自动判定满足；00:00 刷新后未领取失效，不补发；
 * - 领奖幂等（统一约束 1）：user_task_progress(user_id, task_id, task_date) 唯一约束 +
 *   claimed 标志 + fund_flows.idem_key = task:{userId}:{date}:{code}。
 */
@Injectable()
export class TasksService implements OnModuleInit {
  private readonly logger = new Logger(TasksService.name);
  /** 启动同步后的任务定义（含 daily_tasks 行 id；config 顺序即展示顺序） */
  private defs: ResolvedTaskDef[] = [];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly walletService: WalletService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.defs = await runInTransaction(this.dataSource, async (manager) => {
      const configs = getEconomyExt().tasks;
      const rows = await manager.find(DailyTask);
      const byCode = new Map(rows.map((r) => [r.taskCode, r]));
      const resolved: ResolvedTaskDef[] = [];
      for (const cfg of configs) {
        const existed = byCode.get(cfg.code);
        if (existed) {
          // 配置即唯一来源：名称/档位/目标/奖励以 config 为准
          await manager.update(
            DailyTask,
            { id: existed.id },
            { name: cfg.name, tier: cfg.tier, target: cfg.target, reward: cfg.rewardFen },
          );
          resolved.push({ ...cfg, id: existed.id });
        } else {
          const row = await manager.save(
            DailyTask,
            manager.create(DailyTask, {
              taskCode: cfg.code,
              name: cfg.name,
              tier: cfg.tier,
              target: cfg.target,
              reward: cfg.rewardFen,
            }),
          );
          resolved.push({ ...cfg, id: row.id });
        }
      }
      // 已从配置删除的任务及全部用户进度一并移除（FK CASCADE）
      const alive = new Set(configs.map((c) => c.code));
      for (const r of rows) {
        if (!alive.has(r.taskCode)) await manager.delete(DailyTask, { id: r.id });
      }
      return resolved;
    });
    this.logger.log(`每日任务定义同步完成：${this.defs.length} 项`);
  }

  /** 七章.6（钦定口径）：对局开启扣费成功即记档位任务与勤奋玩家进度 */
  @OnEvent('match_started')
  handleMatchStarted(payload: MatchStartedPayload): void {
    void this.recordProgress(payload).catch((e) =>
      this.logger.error(`任务进度记录失败 user=${payload.userId} session=${payload.sessionId}`, e as Error),
    );
  }

  private async recordProgress(payload: MatchStartedPayload): Promise<void> {
    await runInTransaction(this.dataSource, async (manager) => {
      const today = localDateOf(this.clock.now());
      for (const def of this.defs) {
        if (def.tier !== null && def.tier !== payload.tier) continue;
        const row = await manager.findOne(UserTaskProgress, {
          where: { userId: payload.userId, taskId: def.id, taskDate: today },
        });
        if (row) {
          if (row.progress < def.target) {
            await manager.update(UserTaskProgress, { id: row.id }, { progress: row.progress + 1 });
          }
        } else {
          await manager.insert(UserTaskProgress, {
            userId: payload.userId,
            taskId: def.id,
            taskDate: today,
            progress: 1,
            claimed: false,
          });
        }
      }
    });
  }

  /** GET /api/tasks：当日任务 + 进度 + 可领取状态 */
  async list(userId: number): Promise<TasksView> {
    const today = localDateOf(this.clock.now());
    const rows = await this.dataSource.getRepository(UserTaskProgress).find({
      where: { userId, taskDate: today },
    });
    const byTaskId = new Map(rows.map((r) => [r.taskId, r]));
    // 档位名称取自配置（铁律 7 延伸）
    const tierNames = this.tierNames();
    return {
      date: today,
      tasks: this.defs.map((def) => {
        const row = byTaskId.get(def.id);
        const progress = row?.progress ?? 0;
        const claimed = row?.claimed ?? false;
        const completed = progress >= def.target;
        const requirement =
          def.tier !== null
            ? `参加${tierNames[def.tier] ?? '对应'}档 ${def.target} 次`
            : `当日完成任意档位 ${def.target} 局`;
        return {
          code: def.code,
          name: def.name,
          requirement,
          tier: def.tier,
          target: def.target,
          rewardFen: def.rewardFen,
          progress,
          completed,
          claimed,
          claimable: completed && !claimed,
        };
      }),
    };
  }

  private tierNames(): Record<number, string> {
    const { tiersRaw } = getGameRawConfigs();
    const parsed = parseTiersConfig(tiersRaw);
    const names: Record<number, string> = {};
    for (let tier = 1; tier <= 5; tier++) {
      const id = tierIdByInt(tier);
      if (id && parsed.tiers[id]) names[tier] = parsed.tiers[id].name;
    }
    return names;
  }

  /**
   * POST /api/tasks/:id/claim 领奖（:id = 任务 code，6.3 已有此接口）。
   * 幂等：claimed 标志 + idem_key，重复 claim 返回已领取；
   * 【钦定口径】只认当日进度行（task_date = 今日）：00:00 刷新后未领取一律拒绝，不补发。
   */
  async claim(userId: number, code: string): Promise<ClaimTaskView> {
    return runInTransaction(this.dataSource, async (manager) => {
      const def = this.defs.find((d) => d.code === code);
      if (!def) throw new BadRequestException('任务不存在');
      const today = localDateOf(this.clock.now());
      const row = await manager.findOne(UserTaskProgress, {
        where: { userId, taskId: def.id, taskDate: today },
      });
      if (!row) {
        // task_date ≠ 今日一律拒绝：区分「已过期未完成」与「从未有进度」两种提示
        const anyRow = await manager.findOne(UserTaskProgress, {
          where: { userId, taskId: def.id },
          order: { taskDate: 'DESC' },
        });
        if (anyRow) {
          throw new BadRequestException('任务已于 00:00 刷新，未领取奖励已失效（3.8.3：刷新后失效，不补发）');
        }
        throw new BadRequestException('任务未完成，不可领取');
      }
      if (row.progress < def.target) {
        throw new BadRequestException('任务未完成，不可领取');
      }
      const idemKey = `task:${userId}:${today}:${def.code}`;
      if (row.claimed) {
        // 幂等回放：金额/余额一律取 fund_flows 既有行（任务 E 钦定：不以 config 现值回放，
        // 防日后改 economy.json 后回放响应与实发流水不一致）
        const flow = await manager.findOne(FundFlow, { where: { idemKey } });
        if (!flow) throw new Error(`任务幂等回放异常：流水缺失 idem_key=${idemKey}`);
        return { code, rewardFen: flow.amount, balanceFen: flow.balanceAfter, alreadyClaimed: true };
      }
      const balanceFen = await this.credit(manager, userId, def, row.id, idemKey);
      return { code, rewardFen: def.rewardFen, balanceFen, alreadyClaimed: false };
    });
  }

  private async credit(
    manager: EntityManager,
    userId: number,
    def: ResolvedTaskDef,
    progressRowId: number,
    idemKey: string,
  ): Promise<number> {
    const balanceFen = await this.walletService.adjustBalance(manager, {
      userId,
      delta: def.rewardFen,
      type: FundFlowType.Task,
      refId: String(progressRowId),
      idemKey,
    });
    await manager.update(UserTaskProgress, { id: progressRowId }, { claimed: true });
    return balanceFen;
  }
}
