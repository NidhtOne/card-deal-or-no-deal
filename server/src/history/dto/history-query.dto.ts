import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * GET /api/history?tier=&result=&page= 查询参数（docs/开发文档.md 3.10 / 6.3）。
 * 文档外补充（注释标注）：
 * - result 枚举 `profit|loss|even`：3.10 只有中文标签「盈利/亏损/保本」，
 *   转为接口枚举由本 DTO 钦定，分类口径复用 M4 冻结口径（net_profit >0 / <0 / =0）；
 * - page 从 1 起（pageSize 钦定 20，见 history.service.ts）。
 */
export class HistoryQueryDto {
  /** 档位 1–5（3.10「按档位筛选」）；缺省 = 全部档位 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  tier?: number;

  /** 结果筛选（3.10「按结果（盈利/亏损/保本）筛选」）；缺省 = 全部结果 */
  @IsOptional()
  @IsIn(['profit', 'loss', 'even'])
  result?: 'profit' | 'loss' | 'even';

  /** 页码，从 1 起；缺省 = 第 1 页 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
