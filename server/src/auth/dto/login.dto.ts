import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** 登录（docs/开发文档.md 6.1 POST /api/auth/login） */
export class LoginDto {
  @IsString()
  @IsNotEmpty({ message: '请输入用户名' })
  username!: string;

  @IsString()
  @IsNotEmpty({ message: '请输入密码' })
  password!: string;

  /** 「记住我」：Refresh 有效期延长至 30 天（文档未定义具体值，决策为 30 天） */
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
