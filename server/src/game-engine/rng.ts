/**
 * 注入式随机源（seedrandom 风格）。
 * 引擎内一切随机（卡池扰动、洗牌、报价 k、还价抽签、托管选牌）只能经由本模块实例流转；
 * 引擎目录禁止语言内建随机源与时间源，保证同 seed 全流程逐事件可复现。
 *
 * 算法：Alea（Johannes Baagøe 发布的公共领域 PRNG，TypeScript 重写）。
 * 选它的原因：字符串 seed、内部状态为 4 个可 JSON 序列化的数字，
 * 天然支持 getState()/恢复，满足规则四.5.2 的掉线重连随机流续接。
 */

/** Alea 内部状态（可 JSON 序列化） */
export interface AleaState {
  s0: number;
  s1: number;
  s2: number;
  c: number;
}

/** 引擎使用的随机流接口 */
export interface RngStream {
  /** 返回 [0, 1) 均匀分布浮点 */
  next(): number;
  /** 返回 [0, n) 均匀整数；n 必须为正整数 */
  intBelow(n: number): number;
  /** 导出内部状态（供 getState() 快照） */
  getState(): AleaState;
}

const DOUBLE_UNIT = 2.3283064365386963e-10; // 2^-32

/** Alea 的 Mash 混合器：把任意字符串折叠进种子状态 */
function createMash(): (data: string) => number {
  let n = 0xefc8249d;
  return (data: string): number => {
    for (let i = 0; i < data.length; i++) {
      n += data.charCodeAt(i);
      let h = 0.02519603282416938 * n;
      n = h >>> 0;
      h -= n;
      h *= n;
      n = h >>> 0;
      h -= n;
      n += h * 0x100000000; // 2^32
    }
    return (n >>> 0) * DOUBLE_UNIT;
  };
}

function isValidState(state: AleaState): boolean {
  const in01 = (v: number) => typeof v === 'number' && v >= 0 && v < 1;
  return (
    in01(state.s0) && in01(state.s1) && in01(state.s2) && Number.isInteger(state.c) && state.c >= 0
  );
}

/**
 * 创建 Alea 随机流。
 * - 不传 state：以 seed 字符串初始化；
 * - 传 state：从快照恢复（restore() 场景），seed 参数被忽略。
 */
export function createAlea(seed: string, state?: AleaState): RngStream {
  let s0: number;
  let s1: number;
  let s2: number;
  let c: number;
  if (state !== undefined) {
    if (!isValidState(state)) {
      throw new Error('非法的随机流状态快照');
    }
    ({ s0, s1, s2, c } = state);
  } else {
    const mash = createMash();
    s0 = mash(' ');
    s1 = mash(' ');
    s2 = mash(' ');
    c = 1;
    s0 -= mash(seed);
    if (s0 < 0) s0 += 1;
    s1 -= mash(seed);
    if (s1 < 0) s1 += 1;
    s2 -= mash(seed);
    if (s2 < 0) s2 += 1;
  }
  return {
    next(): number {
      const t = 2091639 * s0 + c * DOUBLE_UNIT;
      s0 = s1;
      s1 = s2;
      c = t | 0;
      s2 = t - c;
      return s2;
    },
    intBelow(n: number): number {
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error('intBelow 需要正整数上界');
      }
      return Math.floor(this.next() * n);
    },
    getState(): AleaState {
      return { s0, s1, s2, c };
    },
  };
}
