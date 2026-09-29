/**
 * 可注入时钟接口（任务书 §8：进程内超时定时器配可注入时钟，测试用假时钟）。
 * 通过 CLOCK 注入令牌替换实现；生产为 SystemClock。
 */
export interface Clock {
  /** 当前时间（毫秒 epoch） */
  now(): number;
}

export const CLOCK = Symbol('CLOCK');

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
