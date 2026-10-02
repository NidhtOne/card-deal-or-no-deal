import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { localDateOf, shiftLocalDate } from '../common/local-date';
import { runInTransaction } from '../common/transaction';
import { getEconomyExt } from '../config/economy';
import { DailySignin } from '../entities/daily-signin.entity';
import { FundFlow, FundFlowType } from '../entities/fund-flow.entity';
import { CLOCK, type Clock } from '../match/clock';
import { WalletService } from '../wallet/wallet.service';

/** POST /api/signin 响应（文档 6.3 未定义响应体 —— 文档外补充；金额一律整数分） */
export interface SigninResultView {
  /** 本次是否新签到（false = 当日重复提交的幂等回放） */
  signed: boolean;
  /** 签到日（服务器本地日期 YYYY-MM-DD） */
  signDate: string;
  /** 签到后连签天数 */
  streakDays: number;
  /** 本次奖励（分，= 基数 × 连签倍数，整数运算，无浮点中间量） */
  rewardFen: number;
  /** 本次套用倍数（整数万分比，10000 = ×1.0） */
  multiplierBp: number;
  /** 明日连签奖励预览（分，供大厅展示；断签则回到第 1 档） */
  nextRewardFen: number;
  /** 签到后余额（分） */
  balanceFen: number;
}

/**
 * 每日签到（docs/开发文档.md 3.8.2）：
 * - 每日可签 1 次（自然日口径，不校验当日登录事件），不可补签；「今日」以服务器本地日期为准；
 * - 连续判断 = 上次 sign_date 为昨日则 streak+1，否则 1（含断签清零）；
 * - 奖励 = base × 倍数（3.8.2 倍数表，取档 = day ≤ 连签天数的最后一档），整数运算；
 * - 幂等（统一约束 1）：daily_signins(user_id, sign_date) 唯一约束 +
 *   fund_flows.idem_key = signin:{userId}:{date}，重复提交返回既有奖励，流水仅一条。
 */
@Injectable()
export class SigninService {
  private readonly logger = new Logger(SigninService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly walletService: WalletService,
  ) {}

  /** 取档：day ≤ streak 的最后一档（倍数表已按 day 严格递增校验） */
  multiplierForStreak(streak: number): number {
    const tiers = getEconomyExt().signin.multiplierBp;
    let bp = tiers[0].bp;
    for (const t of tiers) {
      if (t.day <= streak) bp = t.bp;
      else break;
    }
    return bp;
  }

  private rewardForStreak(streak: number): { rewardFen: number; bp: number } {
    const { baseRewardFen } = getEconomyExt().signin;
    const bp = this.multiplierForStreak(streak);
    // 统一约束 3：奖励分 = baseFen × bp / 10000 全程整数运算，禁止浮点中间量
    return { rewardFen: Math.floor((baseRewardFen * bp) / 10000), bp };
  }

  async signin(userId: number): Promise<SigninResultView> {
    return runInTransaction(this.dataSource, async (manager) => {
      const today = localDateOf(this.clock.now());
      const idemKey = `signin:${userId}:${today}`;

      const existing = await manager.findOne(DailySignin, {
        where: { userId, signDate: today },
      });
      if (existing) {
        // 幂等回放（任务 E 钦定）：rewardFen 取落库值、balanceFen 一律取 fund_flows
        // 既有行（按 idem_key 命中，防改配置后回放与实发流水不一致），不重复入账
        const flow = await manager.findOne(FundFlow, { where: { idemKey } });
        if (!flow) throw new Error(`签到幂等回放异常：流水缺失 idem_key=${idemKey}`);
        this.logger.log(`签到幂等回放 user=${userId} date=${today}`);
        return {
          signed: false,
          signDate: today,
          streakDays: existing.streakDays,
          rewardFen: existing.reward,
          multiplierBp: this.multiplierForStreak(existing.streakDays),
          nextRewardFen: this.rewardForStreak(existing.streakDays + 1).rewardFen,
          balanceFen: flow.balanceAfter,
        };
      }

      // 连续判断：上次 sign_date 为昨日则 streak+1，否则 1（断签清零）
      const prev = await manager.findOne(DailySignin, {
        where: { userId },
        order: { signDate: 'DESC' },
      });
      const yesterday = shiftLocalDate(today, -1);
      const streak = prev && prev.signDate === yesterday ? prev.streakDays + 1 : 1;
      const { rewardFen, bp } = this.rewardForStreak(streak);
      const nextRewardFen = this.rewardForStreak(streak + 1).rewardFen;

      const row = await manager.save(
        DailySignin,
        manager.create(DailySignin, {
          userId,
          signDate: today,
          streakDays: streak,
          reward: rewardFen,
        }),
      );
      const balanceFen = await this.walletService.adjustBalance(manager, {
        userId,
        delta: rewardFen,
        type: FundFlowType.Signin,
        refId: String(row.id),
        idemKey,
      });
      return {
        signed: true,
        signDate: today,
        streakDays: streak,
        rewardFen,
        multiplierBp: bp,
        nextRewardFen,
        balanceFen,
      };
    });
  }
}
