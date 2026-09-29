import { Equals, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

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

/**
 * 更新资料（docs/开发文档.md 6.2 PUT /api/user/profile）。
 * 用户名规则与注册一致（3.1.1：4-16 位字母数字下划线），修改频率限制 1 次/30 天（3.2）由服务端判定。
 * 昵称/个性签名长度文档未定义 —— 实现决策：昵称 ≤24 字符、签名 ≤120 字符；空字符串视为清除（存 NULL）。
 */
export class UpdateProfileDto {
  @IsOptional()
  @Matches(/^[A-Za-z0-9_]{4,16}$/, { message: '用户名需为 4-16 位字母数字下划线' })
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24, { message: '昵称最长 24 个字符' })
  nickname?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120, { message: '个性签名最长 120 个字符' })
  signature?: string;
}

/**
 * 更新设置（6.2 PUT /api/user/settings）：3.7 的 8 个设置字段，均可选（部分更新）。
 * volume / sfx_volume 校验 0-100 整数；bgm_track 白名单（assets/music/ 目录现有文件）由服务端判定。
 */
export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  bgmEnabled?: boolean;

  @IsOptional()
  @IsString()
  bgmTrack?: string;

  @IsOptional()
  @IsInt({ message: '音量需为 0-100 的整数' })
  @Min(0, { message: '音量需为 0-100 的整数' })
  @Max(100, { message: '音量需为 0-100 的整数' })
  volume?: number;

  @IsOptional()
  @IsBoolean()
  sfxEnabled?: boolean;

  @IsOptional()
  @IsInt({ message: '音量需为 0-100 的整数' })
  @Min(0, { message: '音量需为 0-100 的整数' })
  @Max(100, { message: '音量需为 0-100 的整数' })
  sfxVolume?: number;

  @IsOptional()
  @IsBoolean()
  amountListEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  riskPopupEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  achievementEnabled?: boolean;
}

/** 「选择内置」银行家（6.2 POST /api/user/banker-character 的 JSON 模式）：传 assets/bankers/ 下文件名 */
export class SelectBankerDto {
  @IsOptional()
  @IsString()
  filename?: string;
}
