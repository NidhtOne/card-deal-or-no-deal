import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { BailoutRecord } from '../entities/bailout-record.entity';
import { DailySignin } from '../entities/daily-signin.entity';
import { UserCharacterImage } from '../entities/user-character-image.entity';
import { UserProfile } from '../entities/user-profile.entity';
import { UserSettings } from '../entities/user-settings.entity';
import { UserWallet } from '../entities/user-wallet.entity';
import { User } from '../entities/user.entity';
import { HistoryModule } from '../history/history.module';
import { MatchModule } from '../match/match.module';
import { UploadModule } from '../upload/upload.module';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserProfile,
      UserSettings,
      UserWallet,
      UserCharacterImage,
      // M4：overview 签到/救助真实字段（文档外补充接口接真实逻辑）
      DailySignin,
      BailoutRecord,
    ]),
    AuthModule,
    UploadModule,
    // 仅复用 CLOCK 注入时钟（MatchModule 导出；「今日」判定统一口径，禁止散落 new Date()）
    MatchModule,
    // M5 阶段 7：数据概览统计项复用 HistoryService（3.2 与 3.10 统计同源）
    HistoryModule,
  ],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
