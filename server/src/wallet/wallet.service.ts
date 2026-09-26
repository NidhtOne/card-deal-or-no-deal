import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { FundFlow, FundFlowType } from '../entities/fund-flow.entity';
import { UserWallet } from '../entities/user-wallet.entity';

export interface AdjustBalanceParams {
  userId: number;
  /** 变动金额，单位分（正入负出） */
  delta: number;
  type: FundFlowType;
  /** 关联对局/任务/成就 ID，可空 */
  refId?: string | null;
  /** 幂等键（铁律 1：领奖/扣费/结算必须幂等；命中唯一约束时直接返回已有结果） */
  idemKey?: string | null;
}

/**
 * 资金原语：一切资金变动的唯一入口。
 * 铁律 1：必须在数据库事务内调用（调用方传入事务 EntityManager），并写 fund_flows 流水。
 * 铁律 2：余额 UPDATE 带余额条件防负余额；idem_key 唯一约束防重复发放。
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  /**
   * 事务内调整余额并写流水，返回调整后余额（单位分）。
   * 余额不足时抛出 WalletInsufficientError；idemKey 已存在时幂等返回。
   */
  async adjustBalance(manager: EntityManager, params: AdjustBalanceParams): Promise<number> {
    const { userId, delta, type, refId = null, idemKey = null } = params;

    if (idemKey) {
      const existed = await manager.findOne(FundFlow, { where: { idemKey } });
      if (existed) {
        this.logger.warn(`幂等命中，跳过重复资金变动 idem_key=${idemKey}`);
        return existed.balanceAfter;
      }
    }

    // 铁律 2：余额条件防负余额（delta 为正时条件恒真，不影响入账）
    const result = await manager
      .createQueryBuilder()
      .update(UserWallet)
      .set({ balance: () => 'balance + :delta' })
      .where('user_id = :userId AND balance + :delta >= 0', { userId, delta })
      .execute();
    if (!result.affected) {
      throw new WalletInsufficientError(userId, delta);
    }

    const wallet = await manager.findOneByOrFail(UserWallet, { userId });
    await manager.insert(FundFlow, {
      userId,
      amount: delta,
      balanceAfter: wallet.balance,
      type,
      refId,
      idemKey,
    });
    return wallet.balance;
  }
}

export class WalletInsufficientError extends Error {
  constructor(
    public readonly userId: number,
    public readonly delta: number,
  ) {
    super('余额不足');
    this.name = 'WalletInsufficientError';
  }
}
