import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUserPayload, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FundFlow } from '../entities/fund-flow.entity';
import { UserWallet } from '../entities/user-wallet.entity';

/**
 * 钱包接口（docs/开发文档.md 6.3：GET /api/wallet 余额与流水）。
 * 响应体字段文档未定义 —— 文档外补充（注释标注）：
 * { balanceFen, flows: [{ id, amountFen, balanceAfterFen, type, refId, createdAt }] }，
 * 金额一律整数分（铁律 4）；flows 为最近 50 条倒序（文档未定义条数 —— 文档外补充，
 * 当前只服务大厅余额/概览展示，完整分页流水随 M4 历史页再议）。
 *
 * 注册位置说明：本 Controller 挂 AppModule 而非 WalletModule —— AuthModule 已依赖
 * WalletModule（注册初始赠送），WalletModule 再引 AuthModule 拿 JwtAuthGuard 会形成循环依赖。
 */
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** GET /api/wallet —— 余额与最近流水 */
  @Get()
  async getWallet(@CurrentUser() user: AuthUserPayload) {
    const wallet = await this.dataSource
      .getRepository(UserWallet)
      .findOne({ where: { userId: user.userId } });
    const flows = await this.dataSource.getRepository(FundFlow).find({
      where: { userId: user.userId },
      order: { id: 'DESC' },
      take: 50,
    });
    return {
      balanceFen: wallet?.balance ?? 0,
      flows: flows.map((f) => ({
        id: f.id,
        amountFen: f.amount,
        balanceAfterFen: f.balanceAfter,
        type: f.type,
        refId: f.refId,
        createdAt: f.createdAt,
      })),
    };
  }
}
