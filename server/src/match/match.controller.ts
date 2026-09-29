import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUserPayload, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CounterDto, PickCardDto, StartMatchDto, SwapDto } from './dto/match.dto';
import { GameSessionService } from './game-session.service';

/**
 * 对局 REST（路径与 docs/开发文档.md 6.3 逐字一致）。
 * 全部服务端校验状态机；命令成功后返回最新玩家视图（脱敏 DTO）。
 */
@Controller('match')
@UseGuards(JwtAuthGuard)
export class MatchController {
  constructor(private readonly sessions: GameSessionService) {}

  /** 传入 tier，事务内扣入场费并生成 26 张卡 */
  @Post('start')
  start(@CurrentUser() user: AuthUserPayload, @Body() dto: StartMatchDto) {
    return this.sessions.start(user.userId, dto.tier, dto.clientKey);
  }

  /** 选定底牌 */
  @Post(':id/pick')
  async pick(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PickCardDto,
  ) {
    await this.sessions.pick(user.userId, id, dto.index);
    return { state: await this.sessions.getStateView(user.userId, id) };
  }

  /** 翻开卡牌（校验轮次配额；同步生成本轮报价） */
  @Post(':id/flip')
  async flip(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number) {
    await this.sessions.flip(user.userId, id);
    return { state: await this.sessions.getStateView(user.userId, id) };
  }

  /** 获取本轮银行家报价（只读；报价唯一生成点在 flip） */
  @Get(':id/offer')
  offer(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number) {
    return this.sessions.getOfferView(user.userId, id);
  }

  /** 接受报价 → 结算 */
  @Post(':id/deal')
  async deal(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number) {
    await this.sessions.deal(user.userId, id);
    return { state: await this.sessions.getStateView(user.userId, id) };
  }

  /** 还价（校验合法性 + 每轮 1 次） */
  @Post(':id/counter')
  async counter(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CounterDto,
  ) {
    await this.sessions.counter(user.userId, id, dto.counter);
    return { state: await this.sessions.getStateView(user.userId, id) };
  }

  /** 拒绝报价 */
  @Post(':id/no-deal')
  async noDeal(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number) {
    await this.sessions.noDeal(user.userId, id);
    return { state: await this.sessions.getStateView(user.userId, id) };
  }

  /** 终局换牌决策 */
  @Post(':id/swap')
  async swap(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SwapDto,
  ) {
    await this.sessions.swap(user.userId, id, dto.swap);
    return { state: await this.sessions.getStateView(user.userId, id) };
  }

  /** 全量状态（重连恢复，脱敏玩家视图） */
  @Get(':id/state')
  state(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number) {
    return this.sessions.getStateView(user.userId, id);
  }

  /** 面额清单（受 user_settings.amount_list_enabled 开关控制） */
  @Get(':id/amount-list')
  amountList(@CurrentUser() user: AuthUserPayload, @Param('id', ParseIntPipe) id: number) {
    return this.sessions.getAmountList(user.userId, id);
  }
}
