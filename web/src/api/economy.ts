import { api } from './client';

/**
 * 经济系统 REST 客户端（M4 第一期：docs/开发文档.md 6.3 签到/任务/破产救助/成就）。
 * 响应体字段以服务端代码为准（server/src/economy/，文档外补充字段已在服务端注释标注）；
 * :id 一律为业务 code（任务/成就定义代码）；金额一律整数分（铁律 4）。
 */

/** POST /api/signin 响应 */
export interface SigninResult {
  /** 本次是否新签到（false = 当日重复提交幂等回放） */
  signed: boolean;
  signDate: string;
  streakDays: number;
  rewardFen: number;
  /** 本次套用倍数（整数万分比，10000 = ×1.0） */
  multiplierBp: number;
  /** 明日连签奖励预览（分；断签则回第 1 档） */
  nextRewardFen: number;
  balanceFen: number;
}

/** GET /api/tasks 任务项 */
export interface TaskItem {
  code: string;
  name: string;
  /** 任务要求文案（服务端组装） */
  requirement: string;
  /** 限定档位 1–5；null = 任意档位 */
  tier: number | null;
  target: number;
  rewardFen: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  claimable: boolean;
}

export interface TasksView {
  /** 任务日期（YYYY-MM-DD；明日 00:00 刷新后未领取失效） */
  date: string;
  tasks: TaskItem[];
}

export interface ClaimTaskResult {
  code: string;
  rewardFen: number;
  balanceFen: number;
  alreadyClaimed: boolean;
}

/** POST /api/bailout 响应 */
export interface BailoutResult {
  amountFen: number;
  /** 当日已用次数（本次计 1 次） */
  timesUsed: number;
  /** 当日剩余次数 */
  remaining: number;
  /**
   * 第 2/3 次申请为 true（3.8.4 提醒弹窗标记，文档外补充字段）。
   * 阶段 6 起由前端消费：受 risk_popup_enabled 控制弹「多次破产救助」提醒（3.11 触发点 2）。
   */
  needsReminder: boolean;
  balanceFen: number;
  refId: number;
}

/** GET /api/achievements 成就项 */
export interface AchievementItem {
  code: string;
  name: string;
  rewardFen: number;
  unlocked: boolean;
  claimed: boolean;
  unlockedAt: string | null;
}

export interface AchievementsView {
  /**
   * 成就总开关（user_settings.achievement_enabled）。
   * 【钦定口径】off 时不弹窗不展示，但后台判定与待领取记录照常累计，
   * 本接口仍返回完整记录，重新开启后可见（文档未定义，服务端注释标注）。
   */
  enabled: boolean;
  list: AchievementItem[];
}

export interface ClaimAchievementResult {
  code: string;
  rewardFen: number;
  balanceFen: number;
  alreadyClaimed: boolean;
}

export const economyApi = {
  signin: () => api.post<SigninResult>('/signin').then((r) => r.data),
  getTasks: () => api.get<TasksView>('/tasks').then((r) => r.data),
  claimTask: (code: string) =>
    api.post<ClaimTaskResult>(`/tasks/${encodeURIComponent(code)}/claim`).then((r) => r.data),
  applyBailout: () => api.post<BailoutResult>('/bailout').then((r) => r.data),
  getAchievements: () => api.get<AchievementsView>('/achievements').then((r) => r.data),
  claimAchievement: (code: string) =>
    api
      .post<ClaimAchievementResult>(`/achievements/${encodeURIComponent(code)}/claim`)
      .then((r) => r.data),
};
