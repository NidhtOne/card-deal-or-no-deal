import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { isUniqueViolation } from '../common/db-error';
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
   *
   * 文档外补充决策：用 SAVEPOINT wallet_adjust 包裹「余额 UPDATE + fund_flows INSERT」。
   * 撞幂等约束时仅撤销本事务内本次资金变动（回滚到保存点），不干扰调用方事务的其他写，
   * 避免「余额加了两次、流水只有一条」的账实不符；调用方必须已在事务内（铁律 1）。
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

    await manager.query('SAVEPOINT wallet_adjust');
    let balanceAfter: number;
    try {
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
      balanceAfter = wallet.balance;
      await manager.insert(FundFlow, {
        userId,
        amount: delta,
        balanceAfter,
        type,
        refId,
        idemKey,
      });
    } catch (e) {
      // 任一步失败：回滚到保存点（此刻本事务对余额零影响），随后释放保存点，事务可继续
      await manager.query('ROLLBACK TO SAVEPOINT wallet_adjust');
      await manager.query('RELEASE SAVEPOINT wallet_adjust');
      // 幂等竞态（文档外补充）：并发下「预检查未命中」与「insert 撞 idem_key UNIQUE 约束」
      // 之间存在竞态窗口。撞约束时回查已有流水并返回其 balance_after，不再向上抛 500。
      if (idemKey && isUniqueViolation(e)) {
        const existed = await manager.findOne(FundFlow, { where: { idemKey } });
        if (existed) {
          this.logger.warn(`幂等键冲突（并发），返回已有流水结果 idem_key=${idemKey}`);
          return existed.balanceAfter;
        }
      }
      // 非 UNIQUE 错误、无 idemKey 或 WalletInsufficientError：原样上抛（保存点已回滚）
      throw e;
    }
    await manager.query('RELEASE SAVEPOINT wallet_adjust');
    return balanceAfter;
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
