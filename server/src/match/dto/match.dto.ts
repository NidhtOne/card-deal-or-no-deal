import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** POST /api/match/start */
export class StartMatchDto {
  /** 档位 1–5（文档 5.1 tier；与引擎 tierId 映射见 match/tier-map.ts） */
  @IsInt()
  @Min(1)
  @Max(5)
  tier!: number;

  /** 客户端幂等键（任务书 §4，文档外补充）：match:{userId}:start:{clientKey} */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  clientKey?: string;
}

/** POST /api/match/:id/pick */
export class PickCardDto {
  /** 底牌牌位 0–25 */
  @IsInt()
  @Min(0)
  @Max(25)
  index!: number;
}

/** POST /api/match/:id/counter（还价金额，整数分） */
export class CounterDto {
  @IsInt()
  @Min(0)
  counter!: number;
}

/** POST /api/match/:id/swap（终局换牌决策：true 换 / false 保留底牌） */
export class SwapDto {
  @IsBoolean()
  swap!: boolean;
}
