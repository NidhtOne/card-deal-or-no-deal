import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { localDateOf } from '../common/local-date';
import { runInTransaction } from '../common/transaction';
import { getEconomyExt } from '../config/economy';
import { BailoutRecord } from '../entities/bailout-record.entity';
import { FundFlowType } from '../entities/fund-flow.entity';
import { GameSession, GameSessionStatus } from '../entities/game-session.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { CLOCK, type Clock } from '../match/clock';
import { WalletService } from '../wallet/wallet.service';

/**
 * 破产救助提醒弹窗标记（docs/开发文档.md 3.11 第 2 条，逐字文案在前端 riskPopupText.ts）。
 * POST /api/bailout 返回 needsReminder 标记（第 2/3 次为 true，文档外补充字段）；
 * 前端阶段 6 已接入：受 user_settings.risk_popup_enabled 控制弹提醒弹窗。
 */
export const BAILOUT_REMINDER_TEXT = '提示：您今日已经多次使用破产救助，请适当休息，注意游戏节奏';

/** POST /api/bailout 响应（文档 6.3 未定义响应体 —— 文档外补充；金额一律整数分） */
export interface BailoutResultView {
  /** 本次入账金额（分） */
  amountFen: number;
  /** 当日已用次数（本次计 1 次） */
  timesUsed: number;
  /** 当日剩余次数 */
  remaining: number;
  /** 第 2/3 次申请为 true（提醒弹窗标记，文档外补充；前端受 risk_popup_enabled 控制弹窗） */
  needsReminder: boolean;
  /** 救助后余额（分） */
  balanceFen: number;
  /** bailout_records 行 id（流水 ref_id 落库） */
  refId: number;
}

/**
 * 破产保护（docs/开发文档.md 3.8.4）：
 * - 仅余额 < threshold（388 元，config 分制比较）可申请；存在「进行」中对局一律拒绝；
 * - 每次救助 amount（500 元），每日最多 max_per_day（3）次，00:00 重置（服务器本地日期）；
 * - 一切资金变动事务内 + fund_flows 流水（type=救助，idem_key = bailout:{userId}:{date}:{nth}）。
 */
@Injectable()
export class BailoutService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly walletService: WalletService,
  ) {}

  async apply(userId: number): Promise<BailoutResultView> {
    const cfg = getEconomyExt().bailout;
    return runInTransaction(this.dataSource, async (manager) => {
      const wallet = await manager.findOne(UserWallet, { where: { userId } });
      const balanceFen = wallet?.balance ?? 0;
      if (balanceFen >= cfg.thresholdFen) {
        throw new BadRequestException('当前余额不符合破产救助申请条件（3.8.4：仅余额低于救助门槛可申请）');
      }
      const playing = await manager.findOne(GameSession, {
        where: { userId, status: GameSessionStatus.Playing },
      });
      if (playing) {
        throw new ConflictException('对局中不可申请破产救助（3.8.4：仅大厅可申请）');
      }
      const today = localDateOf(this.clock.now());
      const used = await manager.count(BailoutRecord, {
        where: { userId, applyDate: today },
      });
      if (used >= cfg.maxPerDay) {
        throw new BadRequestException('今日破产救助次数已用完（00:00 重置）');
      }
      const nth = used + 1;
      const rec = await manager.save(
        BailoutRecord,
        manager.create(BailoutRecord, { userId, applyDate: today, nth }),
      );
      const balanceAfter = await this.walletService.adjustBalance(manager, {
        userId,
        delta: cfg.amountFen,
        type: FundFlowType.Bailout,
        refId: String(rec.id), // ref 落库（统一约束 8）
        idemKey: `bailout:${userId}:${today}:${nth}`,
      });
      // needsReminder：前端阶段 6 已接入弹窗 UI（受 risk_popup_enabled 控制）
      return {
        amountFen: cfg.amountFen,
        timesUsed: nth,
        remaining: cfg.maxPerDay - nth,
        needsReminder: nth >= 2,
        balanceFen: balanceAfter,
        refId: rec.id,
      };
    });
  }

  /** 当日计数查询（大厅入口展示今日已用次数；GET /api/user/overview 消费） */
  async todayUsed(userId: number): Promise<number> {
    const today = localDateOf(this.clock.now());
    return this.dataSource.getRepository(BailoutRecord).count({
      where: { userId, applyDate: today },
    });
  }
}
