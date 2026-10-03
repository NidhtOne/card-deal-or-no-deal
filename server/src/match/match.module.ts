import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { FundFlow } from '../entities/fund-flow.entity';
import { GameCard } from '../entities/game-card.entity';
import { GameSession } from '../entities/game-session.entity';
import { Offer } from '../entities/offer.entity';
// M8：连胜盈利冻结机制计数器表【文档外补充：2026-10-03 人工决策落地】
import { UserGameState } from '../entities/user-game-state.entity';
import { UserSettings } from '../entities/user-settings.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { WalletModule } from '../wallet/wallet.module';
import { CLOCK, SystemClock } from './clock';
import { GameSessionService } from './game-session.service';
import { MatchController } from './match.controller';
import { GameGateway } from './match.gateway';

/**
 * 对局模块（M2）：服务端权威对局会话。
 * 依赖 AuthModule（JWT 守卫/JwtModule 复用 M1）与 WalletModule（资金原语唯一入口）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      GameSession,
      GameCard,
      Offer,
      UserSettings,
      UserWallet,
      FundFlow,
      UserGameState,
    ]),
    AuthModule,
    WalletModule,
  ],
  controllers: [MatchController],
  providers: [GameSessionService, GameGateway, { provide: CLOCK, useClass: SystemClock }],
  // CLOCK 同步导出：M4 经济模块复用同一注入时钟令牌（「今日」判定与超时统一口径）
  exports: [GameSessionService, CLOCK],
})
export class MatchModule {}
