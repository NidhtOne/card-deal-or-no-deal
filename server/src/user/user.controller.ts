import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthUserPayload, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UPLOAD_MAX_BYTES } from '../upload/upload.service';
import {
  ChangePasswordDto,
  DeleteAccountDto,
  SelectBankerDto,
  UpdateProfileDto,
  UpdateSettingsDto,
} from './dto/user.dto';
import {
  BankerOptionsView,
  CharacterHistoryView,
  OverviewView,
  ProfileView,
  SettingsView,
  UserService,
} from './user.service';

/**
 * 用户接口（docs/开发文档.md 6.2，全局前缀 /api）。
 * 上传接口统一走 multer 内存存储 + limits 第一道拦截（>5MB 由 multer 拒绝为 4xx），
 * UploadService 做服务端二次校验与 sharp 重编码（去 EXIF）。
 * 文档外补充：DELETE /api/user（注销）、GET /api/user/character/history、
 * POST /api/user/character/:id/activate、GET /api/user/banker-options、GET /api/user/overview。
 */
@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  /** GET /api/user/profile —— 获取资料 */
  @Get('profile')
  getProfile(@CurrentUser() user: AuthUserPayload): Promise<ProfileView> {
    return this.userService.getProfile(user.userId);
  }

  /** PUT /api/user/profile —— 更新资料（用户名 1 次/30 天，重名 409） */
  @Put('profile')
  updateProfile(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileView> {
    return this.userService.updateProfile(user.userId, dto);
  }

  /** POST /api/user/avatar —— 上传头像（multipart 字段名 file，建议 1:1） */
  @Post('avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } }))
  uploadAvatar(
    @CurrentUser() user: AuthUserPayload,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('请选择要上传的图片');
    return this.userService.updateAvatar(user.userId, file);
  }

  /** POST /api/user/character —— 上传用户角色立绘（multipart 字段名 file，推荐 3:4） */
  @Post('character')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } }))
  uploadCharacter(
    @CurrentUser() user: AuthUserPayload,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('请选择要上传的图片');
    return this.userService.uploadCharacter(user.userId, file);
  }

  /** GET /api/user/character/history —— 角色立绘历史（文档外补充）；未上传时 items 为空 */
  @Get('character/history')
  getCharacterHistory(@CurrentUser() user: AuthUserPayload): Promise<CharacterHistoryView> {
    return this.userService.getCharacterHistory(user.userId);
  }

  /** POST /api/user/character/:id/activate —— 切换生效立绘（文档外补充） */
  @Post('character/:id/activate')
  @HttpCode(200)
  activateCharacter(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ url: string }> {
    return this.userService.activateCharacter(user.userId, id);
  }

  /** GET /api/user/banker-options —— 内置银行家列表（文档外补充） */
  @Get('banker-options')
  getBankerOptions(@CurrentUser() user: AuthUserPayload): Promise<BankerOptionsView> {
    return this.userService.getBankerOptions(user.userId);
  }

  /**
   * POST /api/user/banker-character —— 两种模式：
   * 「选择内置」JSON 传 { filename }（白名单校验 assets/bankers/ 现有文件，拒绝路径穿越）；
   * 「上传自定义」multipart 字段名 file（存 bankers-custom/）。
   */
  @Post('banker-character')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } }))
  setBankerCharacter(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: SelectBankerDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ url: string }> {
    if (file) return this.userService.uploadCustomBanker(user.userId, file);
    if (dto.filename) return this.userService.selectBuiltinBanker(user.userId, dto.filename);
    throw new BadRequestException('请选择内置立绘或上传自定义图片');
  }

  /** GET /api/user/settings —— 获取设置（8 个设置字段 + 曲目白名单） */
  @Get('settings')
  getSettings(@CurrentUser() user: AuthUserPayload): Promise<SettingsView> {
    return this.userService.getSettings(user.userId);
  }

  /** PUT /api/user/settings —— 部分更新设置（volume/sfx_volume 0-100 整数，bgm_track 白名单） */
  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: UpdateSettingsDto,
  ): Promise<SettingsView> {
    return this.userService.updateSettings(user.userId, dto);
  }

  /** GET /api/user/overview —— 账户聚合（文档外补充；统计项与 /api/history/stats 同源） */
  @Get('overview')
  getOverview(@CurrentUser() user: AuthUserPayload): Promise<OverviewView> {
    return this.userService.getOverview(user.userId);
  }

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

  /** DELETE /api/user —— 账号注销（文档外补充）：二次确认后级联删除该用户全部数据与磁盘上传文件 */
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
