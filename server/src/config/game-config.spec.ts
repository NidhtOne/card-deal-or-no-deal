/**
 * 真实配置文件（config/tiers.json、config/economy.json）验收测试。
 * 放在 server/src/config 而非 game-engine 目录内：引擎目录禁止 I/O，读取 JSON 文件属接线侧职责。
 * 附录 A 引擎侧验收项「五档数值」在此钉死。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from './paths';
import {
  createGame,
  parseEconomyConfig,
  parseTiersConfig,
  GameStatus,
  calcTaxFen,
  type GameEvent,
  type OfferMadeEvent,
} from '../game-engine';

function loadJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'config', rel), 'utf8'));
}

const tiersRaw = loadJson('tiers.json');
const economyRaw = loadJson('economy.json');

describe('config/tiers.json：五档数值（3.6.1；附录 A：五档门槛与上限严格固定，不可越级参赛）', () => {
  const cfg = parseTiersConfig(tiersRaw);

  it('五档门槛与上限严格固定', () => {
    const expectFen: Record<string, [number, number]> = {
      atm: [38800, 388800], // 取款机 388 / 3888
      beginner: [200000, 1000000], // 入门 2000 / 10000
      standard: [2000000, 10000000], // 标准 20000 / 100000
      advanced: [8000000, 50000000], // 进阶 80000 / 500000
      master: [22500000, 100000000], // 最高 225000 / 1000000
    };
    expect(cfg.tierOrder).toEqual(['atm', 'beginner', 'standard', 'advanced', 'master']);
    for (const [id, [entry, maxPrize]] of Object.entries(expectFen)) {
      expect(cfg.tiers[id].entryFeeFen).toBe(entry);
      expect(cfg.tiers[id].maxPrizeFen).toBe(maxPrize);
    }
  });

  it('每档模板 26 张唯一、含小额锚点、单张 ≤ 档位上限', () => {
    for (const id of cfg.tierOrder) {
      const tier = cfg.tiers[id];
      expect(tier.amountsFen).toHaveLength(26);
      expect(new Set(tier.amountsFen).size).toBe(26);
      for (const anchor of [1, 10, 100, 1000, 5000]) {
        expect(tier.amountsFen).toContain(anchor);
      }
      expect(Math.max(...tier.amountsFen)).toBeLessThanOrEqual(tier.maxPrizeFen);
      expect(tier.amountsFen.every((v) => v > 0)).toBe(true);
      expect(tier.weights).toHaveLength(26);
      expect(tier.weights.every((w) => w > 0)).toBe(true);
    }
  });

  it('档位越高大额权重越高（高档尾部权重 > 低档）', () => {
    const tailWeight = (id: string) => {
      const w = cfg.tiers[id].weights;
      return w.slice(-5).reduce((a, b) => a + b, 0) / 5;
    };
    expect(tailWeight('beginner')).toBeGreaterThan(tailWeight('atm'));
    expect(tailWeight('standard')).toBeGreaterThan(tailWeight('beginner'));
    expect(tailWeight('advanced')).toBeGreaterThan(tailWeight('standard'));
    expect(tailWeight('master')).toBeGreaterThan(tailWeight('advanced'));
  });

  it('公共节：翻牌序列 6/5/4/3/2、k 区间 0.55-0.75/0.65-0.85/0.80-0.95、还价参数 0.85/0.9/0.3', () => {
    expect(cfg.common.flipSequence).toEqual([6, 5, 4, 3, 2]);
    expect(cfg.common.kRanges.early).toEqual({ min: 0.55, max: 0.75 });
    expect(cfg.common.kRanges.mid).toEqual({ min: 0.65, max: 0.85 });
    expect(cfg.common.kRanges.final).toEqual({ min: 0.8, max: 0.95 });
    expect(cfg.common.counter).toEqual({ acceptRatio: 0.85, probHi: 0.9, probLo: 0.3 });
  });
});

describe('config/economy.json：阶梯税（铁律 8 修正版）', () => {
  it('税节解析正确且验收例成立：盈利 20000 元 → 税 1550 元', () => {
    const eco = parseEconomyConfig(economyRaw);
    expect(eco.tax.thresholdFen).toBe(100000);
    expect(eco.tax.bracketsFen).toEqual([500000, 2000000, 10000000, 50000000]);
    expect(eco.tax.ratesBp).toEqual([300, 1000, 2000, 2800, 3500]);
    expect(calcTaxFen(2000000, eco.tax).taxFen).toBe(155000);
    expect(calcTaxFen(-1, eco.tax).taxFen).toBe(0); // 亏损局税 0
  });

  it('预留空节存在（signin/tasks/bailout/achievements）', () => {
    const raw = economyRaw as Record<string, unknown>;
    for (const key of ['signin', 'tasks', 'bailout', 'achievements']) {
      expect(raw).toHaveProperty(key);
    }
  });
});

describe('真实配置 × 引擎：全档全流程托管性质验收', () => {
  it('五档 × 多 seed：26 张唯一、报价 ≤EV 且 ≤上限非负、托管收敛结算', () => {
    const cfg = parseTiersConfig(tiersRaw);
    for (const tierId of cfg.tierOrder) {
      for (const seed of [`${tierId}-s1`, `${tierId}-s2`]) {
        const game = createGame({ tierId, seed, tiersConfig: tiersRaw, economyConfig: economyRaw });
        game.autoResolve();
        const state = game.getState();
        expect(state.status).toBe(GameStatus.Settle);
        // 卡池
        expect(new Set(state.poolFen).size).toBe(26);
        for (const v of state.poolFen) {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(v).toBeLessThanOrEqual(state.tier.maxPrizeFen);
        }
        // 报价不变量
        const offers = state.events.filter(
          (e): e is Extract<GameEvent, { type: 'offer_made' }> => e.type === 'offer_made',
        );
        expect(offers).toHaveLength(10);
        for (const o of offers as OfferMadeEvent[]) {
          expect(o.offerFen).toBeGreaterThanOrEqual(0);
          expect(o.offerFen).toBeLessThanOrEqual(o.evFen);
          expect(o.offerFen).toBeLessThanOrEqual(state.tier.maxPrizeFen);
        }
        // 结算：税与纯函数一致
        expect(state.settlement).not.toBeNull();
        expect(state.settlement!.taxFen).toBe(
          calcTaxFen(state.settlement!.profitFen, state.tax).taxFen,
        );
      }
    }
  });
});
