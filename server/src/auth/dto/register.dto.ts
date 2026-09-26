import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

/** 注册（docs/开发文档.md 6.1 POST /api/auth/register，字段规则见 3.1.1） */
export class RegisterDto {
  /** 用户名：4-16 位字母数字下划线 */
  @Matches(/^[A-Za-z0-9_]{4,16}$/, { message: '用户名需为 4-16 位字母、数字或下划线' })
  username!: string;

  /** 密码：8-20 位，至少含字母与数字 */
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).{8,20}$/, {
    message: '密码需为 8-20 位且同时包含字母和数字',
  })
  password!: string;

  @IsString()
  @IsNotEmpty({ message: '请再次输入密码' })
  confirmPassword!: string;

  /** 密保问题（必填，本地找回密码方式①） */
  @IsString()
  @Length(1, 100, { message: '密保问题不能为空' })
  securityQuestion!: string;

  /** 密保答案（必填，服务端 bcrypt 哈希存储） */
  @IsString()
  @Length(1, 100, { message: '密保答案不能为空' })
  securityAnswer!: string;
}
