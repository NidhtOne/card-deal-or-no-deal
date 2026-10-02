import type { DataSource } from 'typeorm';
import type { Clock } from '../match/clock';
import type { WalletService } from '../wallet/wallet.service';
import { SigninService } from './signin.service';

/**
 * multiplierForStreak 取档边界（任务书 §8.5）：档位恰落各档、7 天起封顶、超表尾。
 * 倍数表数值来自 config/economy.json（铁律 7：数值以 config 为准，此处为断言钉死值）：
 * day=1 → 10000、day=2 → 12000、day=3 → 15000、day=4 → 18000、day=7 → 20000（封顶档）。
 */

function newService(): SigninService {
  return new SigninService(
    undefined as unknown as DataSource,
    undefined as unknown as Clock,
    undefined as unknown as WalletService,
  );
}

describe('SigninService.multiplierForStreak 取档边界', () => {
  const service = newService();

  it('streak 恰落各档下限：1/2/3/4 → 10000/12000/15000/18000', () => {
    expect(service.multiplierForStreak(1)).toBe(10000); // ×1.0
    expect(service.multiplierForStreak(2)).toBe(12000); // ×1.2
    expect(service.multiplierForStreak(3)).toBe(15000); // ×1.5
    expect(service.multiplierForStreak(4)).toBe(18000); // ×1.8
  });

  it('档内区间：5、6 天仍取 day=4 档（×1.8）', () => {
    expect(service.multiplierForStreak(5)).toBe(18000);
    expect(service.multiplierForStreak(6)).toBe(18000);
  });

  it('7 天起封顶 ×2.0，超表尾（8/30/365 天）仍封顶', () => {
    expect(service.multiplierForStreak(7)).toBe(20000);
    expect(service.multiplierForStreak(8)).toBe(20000);
    expect(service.multiplierForStreak(30)).toBe(20000);
    expect(service.multiplierForStreak(365)).toBe(20000);
  });

  it('防御：streak=0 落回首档（业务恒 streak ≥ 1，仅兜底不抛错）', () => {
    expect(service.multiplierForStreak(0)).toBe(10000);
  });
});
