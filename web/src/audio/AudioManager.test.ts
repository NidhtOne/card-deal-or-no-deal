import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AudioManager 单测（铁律 9）。
 * mock howler 模块（禁止 jsdom 依赖真实 WebAudio）：FakeHowl 记录构造参数与调用，
 * 通过 (Howl as any).instances 观察实例；playing() 受 __howlerBlocked 全局开关控制
 * 以模拟浏览器自动播放受限。
 */
vi.mock('howler', () => {
  class Howl {
    opts: Record<string, unknown>;
    src: string;
    playCalls = 0;
    stopCalls = 0;
    unloadCalls = 0;
    volumeCalls: number[] = [];
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      this.src = (opts.src as string[])[0];
      (this.constructor as unknown as { instances: unknown[] }).instances.push(this);
    }
    play(): number {
      this.playCalls += 1;
      return 1;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    playing(_id?: number): boolean {
      return !(globalThis as { __howlerBlocked?: boolean }).__howlerBlocked;
    }
    stop(): void {
      this.stopCalls += 1;
    }
    unload(): void {
      this.unloadCalls += 1;
    }
    volume(v?: number): number {
      if (v !== undefined) this.volumeCalls.push(v);
      return 1;
    }
  }
  (Howl as unknown as { instances: unknown[] }).instances = [];
  return { Howl, Howler: { volume: vi.fn(), ctx: null } };
});

import * as mod from './AudioManager';
import { Howl } from 'howler';

const { AudioManager } = mod;

/** 场景映射所需的白名单（与服务端扫描 assets/music/ 的产物一致） */
const TRACKS = ['finale.wav', 'loading.wav', 'lobby.wav', 'match.wav'];

/** FakeHowl 观察面（mock 实例的构造参数与调用记录） */
interface FakeHowl {
  opts: Record<string, unknown>;
  src: string;
  playCalls: number;
  stopCalls: number;
  unloadCalls: number;
  volumeCalls: number[];
}

function fakeInstances(): FakeHowl[] {
  return (Howl as unknown as { instances: FakeHowl[] }).instances;
}

/** 基础设置快照 */
function settings(over: Partial<mod.AudioSettings> = {}): mod.AudioSettings {
  return {
    bgmEnabled: true,
    bgmTrack: 'lobby.wav',
    volume: 60,
    sfxEnabled: true,
    sfxVolume: 80,
    availableTracks: TRACKS,
    ...over,
  };
}

beforeEach(() => {
  AudioManager.resetForTest();
  fakeInstances().length = 0;
  (globalThis as { __howlerBlocked?: boolean }).__howlerBlocked = false;
});

describe('单例性（3.9：统一管理，禁止多实例）', () => {
  it('模块只导出实例，不导出可构造类', () => {
    expect(typeof AudioManager).toBe('object');
    expect((mod as Record<string, unknown>).AudioManagerImpl).toBeUndefined();
    expect(new Set(Object.keys(mod))).toEqual(new Set(['AudioManager']));
  });

  it('同一时刻至多一个 BGM 实例在播（切曲 = 停旧建新）', () => {
    AudioManager.syncSettings(settings());
    AudioManager.syncScene('/lobby');
    AudioManager.syncScene('/match/play/1');
    const bgms = fakeInstances().filter((h) => h.opts.loop === true);
    expect(bgms).toHaveLength(2);
    expect(bgms[0].stopCalls).toBeGreaterThan(0);
    expect(bgms[0].unloadCalls).toBeGreaterThan(0);
    expect(AudioManager.getCurrentTrack()).toBe('match.wav');
  });
});

describe('页面氛围映射（文档外补充口径：氛围页固定映射优先于用户选曲）', () => {
  it.each([
    ['/match/load/3', 'loading.wav'],
    ['/match/play/3', 'match.wav'],
    ['/match/result/3', 'finale.wav'],
    ['/lobby', 'custom.wav'], // 其余页面（含大厅）→ bgm_track 所选曲
    ['/settings', 'custom.wav'],
    ['/login', 'custom.wav'],
  ])('%s → %s', (pathname, expected) => {
    AudioManager.syncSettings(settings({ bgmTrack: 'custom.wav' }));
    AudioManager.syncScene(pathname);
    expect(AudioManager.getCurrentTrack()).toBe(expected);
    const last = fakeInstances()[fakeInstances().length - 1];
    expect(last.src.endsWith(expected)).toBe(true);
  });

  it('用户选曲与氛围曲同名时氛围页照常播放该曲', () => {
    AudioManager.syncSettings(settings({ bgmTrack: 'match.wav' }));
    AudioManager.syncScene('/match/play/9');
    expect(AudioManager.getCurrentTrack()).toBe('match.wav');
  });

  it('氛围曲文件被删（不在白名单）时回退 bgm_track', () => {
    AudioManager.syncSettings(settings({ bgmTrack: 'custom.wav', availableTracks: ['custom.wav'] }));
    AudioManager.syncScene('/match/play/1');
    expect(AudioManager.getCurrentTrack()).toBe('custom.wav');
  });
});

describe('bgm_enabled=false 即静默（3.9）', () => {
  it('不起播、不建 Howl 实例', () => {
    AudioManager.syncSettings(settings({ bgmEnabled: false }));
    AudioManager.syncScene('/lobby');
    AudioManager.syncScene('/match/play/1');
    expect(AudioManager.isPlaying()).toBe(false);
    expect(fakeInstances().filter((h) => h.opts.loop === true)).toHaveLength(0);
  });

  it('播放中关闭立即停曲', () => {
    AudioManager.syncSettings(settings());
    AudioManager.syncScene('/lobby');
    const bgm = fakeInstances()[0];
    AudioManager.syncSettings(settings({ bgmEnabled: false }));
    expect(bgm.stopCalls).toBeGreaterThan(0);
    expect(AudioManager.isPlaying()).toBe(false);
  });
});

describe('音量换算（0-100 整数 / 100 → 0-1）', () => {
  it('BGM 音量 65 → 0.65（构造与实时调整）', () => {
    AudioManager.syncSettings(settings({ volume: 65 }));
    AudioManager.syncScene('/lobby');
    const bgm = fakeInstances()[0];
    expect(bgm.opts.volume).toBe(0.65);
    AudioManager.syncSettings(settings({ volume: 30 }));
    expect(bgm.volumeCalls).toContain(0.3);
  });

  it('音效音量 40 → 0.40', () => {
    AudioManager.syncSettings(settings({ sfxVolume: 40 }));
    AudioManager.playSfx('flip');
    const sfx = fakeInstances().find((h) => h.opts.loop !== true);
    expect(sfx?.src.endsWith('/sfx/flip.wav')).toBe(true);
    expect(sfx?.opts.volume).toBe(0.4);
  });
});

describe('音效事件（6 个，文档外补充）受 sfx_enabled 独立控制', () => {
  it('sfx_enabled=false 不播（即使 bgm 开着）', () => {
    AudioManager.syncSettings(settings({ sfxEnabled: false }));
    AudioManager.playSfx('deal');
    expect(fakeInstances().find((h) => h.opts.loop !== true)).toBeUndefined();
  });

  it('bgm_enabled=false 不影响音效', () => {
    AudioManager.syncSettings(settings({ bgmEnabled: false }));
    AudioManager.playSfx('settle');
    const sfx = fakeInstances().find((h) => h.opts.loop !== true);
    expect(sfx?.playCalls).toBe(1);
  });

  it('同一事件复用 Howl 实例（重复播放不重建）', () => {
    AudioManager.syncSettings(settings());
    AudioManager.playSfx('offer');
    AudioManager.playSfx('offer');
    const sfxs = fakeInstances().filter((h) => h.opts.loop !== true);
    expect(sfxs).toHaveLength(1);
    expect(sfxs[0].playCalls).toBe(2);
  });
});

describe('自动播放受限：一次性交互解锁（3.9）', () => {
  it('播放被拦时挂 pointerdown/keydown 监听，首次交互后重试播放', () => {
    vi.stubGlobal('window', new EventTarget());
    (globalThis as { __howlerBlocked?: boolean }).__howlerBlocked = true;
    try {
      AudioManager.syncSettings(settings());
      AudioManager.syncScene('/lobby');
      const bgm = fakeInstances()[0];
      expect(bgm.playCalls).toBe(1); // 首次尝试（被浏览器拦下）

      window.dispatchEvent(new Event('pointerdown'));
      expect(bgm.playCalls).toBe(2); // 首次交互后启动
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('播放成功时不挂监听', () => {
    vi.stubGlobal('window', new EventTarget());
    try {
      AudioManager.syncSettings(settings());
      AudioManager.syncScene('/lobby');
      const bgm = fakeInstances()[0];
      window.dispatchEvent(new Event('pointerdown'));
      expect(bgm.playCalls).toBe(1); // 无解锁重试
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('登出释放', () => {
  it('dispose 停曲并卸载全部实例', () => {
    AudioManager.syncSettings(settings());
    AudioManager.syncScene('/lobby');
    AudioManager.playSfx('flip');
    const bgm = fakeInstances()[0];
    AudioManager.dispose();
    expect(AudioManager.isPlaying()).toBe(false);
    expect(AudioManager.getCurrentTrack()).toBeNull();
    expect(bgm.unloadCalls).toBeGreaterThan(0);
  });
});
