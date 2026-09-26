import { Equals, IsNotEmpty, IsString, Matches } from 'class-validator';

/** 修改密码（docs/开发文档.md 6.2 POST /api/user/password，3.1.3 需验证原密码） */
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: '请输入原密码' })
  oldPassword!: string;

  /** 新密码规则与注册一致（3.1.1：8-20 位且同时包含字母和数字） */
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).{8,20}$/, {
    message: '密码需为 8-20 位且同时包含字母和数字',
  })
  newPassword!: string;
}

/**
 * 账号注销（6.1/6.2 未定义 —— 文档外补充；3.1.3：二次确认后删除个人数据）。
 * 二次确认通过请求体确认字段表达：confirm 必须为 true。
 */
export class DeleteAccountDto {
  @Equals(true, { message: '请确认注销操作（confirm 必须为 true）' })
  confirm!: boolean;
}
