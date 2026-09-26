import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';
import { WalletModule } from '../wallet/wallet.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  // 铁律 5：密钥只从 .env 读取；缺失时直接拒绝启动（npm run dev 会先生成）
  throw new Error('JWT_SECRET 未配置：请先运行 npm run dev 自动生成，或在 .env 中手动配置');
}

@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken]),
    // Access Token 2 小时（3.1.2）
    JwtModule.register({ secret: jwtSecret, signOptions: { expiresIn: '2h' } }),
    WalletModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
