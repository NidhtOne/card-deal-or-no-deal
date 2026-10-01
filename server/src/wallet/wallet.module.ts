import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FundFlow } from '../entities/fund-flow.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { WalletService } from './wallet.service';

/**
 * 资金模块：事务内资金原语 WalletService（一切资金变动的唯一入口）。
 * 6.3 的 GET /api/wallet 接口见 wallet.controller.ts（注册于 AppModule，原因见该文件注释）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserWallet, FundFlow])],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
