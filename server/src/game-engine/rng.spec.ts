import { createAlea } from './rng';

describe('game-engine/rng（Alea 注入式随机源）', () => {
  it('同 seed 序列逐项一致（可复现）', () => {
    const a = createAlea('seed-42');
    const b = createAlea('seed-42');
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('异 seed 序列不同', () => {
    const a = createAlea('seed-a');
    const b = createAlea('seed-b');
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('输出落在 [0, 1)', () => {
    const rng = createAlea('range-check');
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('getState/fromState 状态往返后续流一致（断点续接）', () => {
    const a = createAlea('stateful');
    for (let i = 0; i < 17; i++) a.next();
    const state = a.getState();
    // 状态必须可 JSON 序列化往返
    const b = createAlea('stateful', JSON.parse(JSON.stringify(state)));
    for (let i = 0; i < 500; i++) {
      expect(b.next()).toBe(a.next());
    }
  });

  it('空字符串 seed 也可确定性工作', () => {
    const a = createAlea('');
    const b = createAlea('');
    expect(a.next()).toBe(b.next());
    expect(a.next()).toBeGreaterThanOrEqual(0);
  });

  it('intBelow 均匀落在 [0, n)', () => {
    const rng = createAlea('int-below');
    for (let i = 0; i < 1000; i++) {
      const v = rng.intBelow(26);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(26);
    }
  });

  it('intBelow(0/负数) 抛错', () => {
    const rng = createAlea('bad-int');
    expect(() => rng.intBelow(0)).toThrow();
    expect(() => rng.intBelow(-3)).toThrow();
  });

  it('非法状态快照抛错（恢复入口校验）', () => {
    expect(() => createAlea('x', { s0: 1.5, s1: 0.2, s2: 0.3, c: 1 })).toThrow();
    expect(() => createAlea('x', { s0: 0.1, s1: 0.2, s2: 0.3, c: -1 })).toThrow();
    expect(() => createAlea('x', { s0: 0.1, s1: 0.2, s2: 0.3, c: 1 })).not.toThrow();
  });
});
