import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * user_game_state —— 用户对局累计状态表【文档外补充：2026-10-03 人工决策落地】。
 *
 * 背景：M8 两项人工决策需要跨局持久化状态（决策原文：冻结状态持久化、重启不丢，禁用内存态）：
 * - 连胜盈利冻结机制（win_streak_guard）依赖 win_streak / streak_profit_fen / guard_frozen /
 *   guard_triggered_at 四个计数器；
 * - 成就判定与 game_sessions 物理清理解耦（历史清理会删行，回扫口径失效）：
 *   连胜猎手读 win_streak、初出茅庐/勤劳玩家读 total_settled_games。
 *
 * 口径（任务书 §8d/§8g 钦定，与 M4 口径 d 一致）：
 * - win_streak：当前连续盈利局数（net_profit > 0 → +1；< 0 → 清零；= 0 保本「不中断不计入」不变）；
 * - streak_profit_fen：当前连续盈利段税后净利累计（分）；
 * - guard_frozen：0/1 冻结标志（输一局解除 + reset_hours 定时解除）；
 * - guard_triggered_at：冻结触发时刻（epoch 毫秒，沿用项目时间戳惯例；未冻结为 NULL）；
 * - total_settled_games：累计结算局数（含超时托管结算局，M4 口径）。
 *
 * 行由结算事务懒建（新用户默认全 0）；存量用户由 migration 一次性回填。
 * 铁律 4：金额一律 INTEGER，单位「分」。
 */
@Entity('user_game_state')
export class UserGameState {
  /** 用户 id（主键；FK 级联删除与既有用户子表口径一致） */
  @PrimaryColumn({ name: 'user_id' })
  userId!: number;

  /** 当前连续盈利局数 */
  @Column({ name: 'win_streak', default: 0 })
  winStreak!: number;

  /** 当前连续盈利段税后净利累计（分） */
  @Column({ name: 'streak_profit_fen', default: 0 })
  streakProfitFen!: number;

  /** 冻结标志（0/1） */
  @Column({ name: 'guard_frozen', default: 0 })
  guardFrozen!: number;

  /** 冻结触发时刻（epoch 毫秒；未冻结为 NULL） */
  @Column({ name: 'guard_triggered_at', type: 'integer', nullable: true })
  guardTriggeredAt!: number | null;

  /** 累计结算局数（含超时托管结算局） */
  @Column({ name: 'total_settled_games', default: 0 })
  totalSettledGames!: number;
}
