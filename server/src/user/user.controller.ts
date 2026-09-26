import { Body, Controller, Delete, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthUserPayload, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChangePasswordDto, DeleteAccountDto } from './dto/user.dto';
import { UserService } from './user.service';

/**
 * 用户接口（docs/开发文档.md 6.2，全局前缀 /api）。
 * 本阶段范围：POST /api/user/password（修改密码）、DELETE /api/user（注销，文档外补充）。
 * 6.2 的 profile/settings 读写与文件上传接口属下一阶段范围，不在此实现。
 */
@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  /** POST /api/user/password —— 修改密码（验原密码） */
  @Post('password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    await this.userService.changePassword(user.userId, dto.oldPassword, dto.newPassword);
    return { ok: true };
  }

  /** DELETE /api/user —— 账号注销（文档外补充）：二次确认后级联删除该用户全部数据 */
  @Delete()
  async deleteAccount(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: DeleteAccountDto,
  ): Promise<{ ok: boolean }> {
    // dto.confirm 已由 class-validator @Equals(true) 保证（二次确认）
    await this.userService.deleteAccount(user.userId);
    return { ok: dto.confirm };
  }
}
