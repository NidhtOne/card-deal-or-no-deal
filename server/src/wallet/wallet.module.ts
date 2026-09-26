import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FundFlow } from '../entities/fund-flow.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { WalletService } from './wallet.service';

/**
 * 资金模块：本阶段仅提供事务内资金原语 WalletService（注册初始赠送使用）；
 * 6.3 经济与对局接口（GET /api/wallet 等）属下一阶段范围，不在此实现。
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserWallet, FundFlow])],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
