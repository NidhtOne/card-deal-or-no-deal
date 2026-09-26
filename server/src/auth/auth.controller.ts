import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { AuthService, TokenBundle } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto, LogoutDto, RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthUserPayload, CurrentUser, JwtAuthGuard } from './jwt-auth.guard';

/**
 * 账号接口（docs/开发文档.md 6.1，全局前缀 /api）。
 * 文档外补充：check-username（3.1.1 唯一性实时校验）、security-question（找回密码页展示）、
 * session（前端路由守卫/自动刷新验证用轻量会话探针）。
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** POST /api/auth/register —— 注册（含密保问题），成功自动登录返回双令牌 */
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<TokenBundle> {
    return this.authService.register(dto);
  }

  /** GET /api/auth/check-username?username= —— 用户名唯一性实时校验（文档外补充） */
  @Get('check-username')
  checkUsername(@Query('username') username?: string): Promise<{ available: boolean }> {
    return this.authService.checkUsername(username ?? '');
  }

  /** GET /api/auth/security-question?username= —— 取密保问题（文档外补充） */
  @Get('security-question')
  getSecurityQuestion(@Query('username') username?: string): Promise<{ question: string }> {
    return this.authService.getSecurityQuestion(username ?? '');
  }

  /** POST /api/auth/login —— 登录（支持「记住我」，Refresh 延长至 30 天） */
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto): Promise<TokenBundle> {
    return this.authService.login(dto);
  }

  /** POST /api/auth/refresh —— 轮换（旧 Refresh 立即吊销，重放返回 401） */
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto): Promise<TokenBundle> {
    return this.authService.refresh(dto.refreshToken);
  }

  /** POST /api/auth/logout —— 吊销 Refresh Token */
  @Post('logout')
  @HttpCode(200)
  logout(@Body() dto: LogoutDto): Promise<{ ok: true }> {
    return this.authService.logout(dto.refreshToken);
  }

  /** POST /api/auth/forgot-password —— 密保问题校验 + 重置密码 */
  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ ok: true }> {
    return this.authService.forgotPassword(dto);
  }

  /** GET /api/auth/session —— 当前登录用户（文档外补充：供前端路由守卫/刷新验证） */
  @Get('session')
  @UseGuards(JwtAuthGuard)
  session(@CurrentUser() user: AuthUserPayload): { user: AuthUserPayload } {
    return { user };
  }
}
