import { IsNotEmpty, IsString, Matches } from 'class-validator';

/** 刷新令牌（docs/开发文档.md 6.1 POST /api/auth/refresh） */
export class RefreshDto {
  @IsString()
  @IsNotEmpty({ message: '缺少 refreshToken' })
  refreshToken!: string;
}

/** 登出（docs/开发文档.md 6.1 POST /api/auth/logout） */
export class LogoutDto {
  @IsString()
  @IsNotEmpty({ message: '缺少 refreshToken' })
  refreshToken!: string;
}

/** 找回密码（docs/开发文档.md 6.1 POST /api/auth/forgot-password，3.1.1 方式①） */
export class ForgotPasswordDto {
  @IsString()
  @IsNotEmpty({ message: '请输入用户名' })
  username!: string;

  @IsString()
  @IsNotEmpty({ message: '请输入密保答案' })
  securityAnswer!: string;

  /** 新密码规则与注册一致（3.1.1：8-20 位且同时包含字母和数字） */
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).{8,20}$/, {
    message: '密码需为 8-20 位且同时包含字母和数字',
  })
  newPassword!: string;
}
