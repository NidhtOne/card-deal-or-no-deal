import { Howl, Howler } from 'howler';

/**
 * AudioManager —— 全站音频单例（docs/开发文档.md 3.9：前端统一用 Howler.js 管理，避免多实例冲突）。
 *
 * 【文档外补充：3.9 未定义细化口径，以下均为钦定并注释标注】
 * 1. bgm_track = 大厅默认曲（用户在设置页所选曲目）。
 * 2. 页面氛围映射（固定文件名，优先于用户选曲）：
 *    /match/load → loading 曲（紧张氛围，3.9「加载页播放紧张氛围曲」）
 *    /match/play → match 曲（3.9「进入对局可切换对局专用曲目」）
 *    /match/result → finale 曲
 *    其余页面（含大厅）→ bgm_track 所选曲
 *    氛围页曲目文件缺失时回退 bgm_track 所选曲（不报错）。
 * 3. 音效事件清单（6 个）亦为文档外补充（3.9 仅写「翻牌、报价、成交等音效」示意）：
 *    flip=翻牌、offer=报价出现、deal=成交、nodeal=拒绝、reveal=开牌（终局换牌揭晓）、settle=结算。
 *
 * 播放策略（3.9）：进入站点若 bgm_enabled 则尝试播放；浏览器自动播放受限时挂一次性
 * pointerdown/keydown 监听在首次交互后启动；路由切换只切 BGM 曲目（停旧曲起新曲），
 * 不中断音效实例；bgm_enabled=false 即静默不播。
 *
 * 音量：settings.volume / sfx_volume 为 0-100 整数（后端已校验），统一 /100 转 Howler 的 0-1。
 */

/** BGM 氛围曲固定文件名（assets/music/；替换音频请同名替换，见该目录 README） */
const AMBIENT_TRACKS = {
  loading: 'loading.wav',
  match: 'match.wav',
  finale: 'finale.wav',
} as const;

/** 音效文件名（assets/music/sfx/，子目录为文档外补充） */
const SFX_FILES = {
  flip: 'flip.wav',
  offer: 'offer.wav',
  deal: 'deal.wav',
  nodeal: 'nodeal.wav',
  reveal: 'reveal.wav',
  settle: 'settle.wav',
} as const;

/** 音效事件名（受 sfx_enabled/sfx_volume 独立控制，与 BGM 解耦） */
export type SfxEvent = keyof typeof SFX_FILES;

/** 音频设置快照（来自 GET /api/user/settings 的 8 字段子集 + 曲目白名单） */
export interface AudioSettings {
  bgmEnabled: boolean;
  bgmTrack: string;
  volume: number;
  sfxEnabled: boolean;
  sfxVolume: number;
  /** 服务端扫描 assets/music/ 生成的白名单（氛围曲缺失时回退选曲用） */
  availableTracks?: string[];
}

/** 大厅默认曲兜底（bgmTrack 为空串时；正常不会出现，后端白名单校验兜底） */
const DEFAULT_TRACK = 'lobby.wav';

/**
 * 模块级单例（3.9「统一管理，避免多实例冲突」）。
 * 同一页面生命周期内只存在一个 BGM Howl 播放实例（切曲 = 停旧建新，同一时刻至多 1 个）。
 */
class AudioManagerImpl {
  /** 当前 BGM 曲目文件名（含 None 标记） */
  private currentTrack: string | null = null;
  /** 当前 BGM Howl 实例（同一时刻至多 1 个） */
  private bgm: Howl | null = null;
  /** 音效 Howl 实例池（按事件缓存，短音效重放用 play() 重触发，避免频繁重建） */
  private readonly sfx = new Map<SfxEvent, Howl>();
  /** 最近一次同步的设置快照 */
  private settings: AudioSettings | null = null;
  /** 自动播放解锁监听是否已挂载 */
  private unlockArmed = false;
  /** 供测试注入的曲目前缀（assets 托管路径） */
  private readonly basePath: string;

  constructor(basePath = '/assets/music/') {
    this.basePath = basePath;
  }

  /** 当前生效的 BGM 曲目文件名（测试用：验证切曲逻辑） */
  getCurrentTrack(): string | null {
    return this.currentTrack;
  }

  /** BGM 是否正在播放 */
  isPlaying(): boolean {
    return this.bgm !== null;
  }

  /**
   * 同步设置并按需调整播放（设置页保存后 / 登录加载设置后调用）。
   * - 音量实时生效（不打断正在播的曲）；
   * - bgm_enabled / bgm_track 变化立即起停切曲；
   * - 尚未 syncScene 定位页面时只记录设置（首次 syncScene 时统一起播）。
   */
  syncSettings(s: AudioSettings): void {
    const prev = this.settings;
    this.settings = { ...s };
    Howler.volume(1); // 主总线固定满格，BGM/音效各自独立音量
    if (!prev) return; // 首次同步：等 syncScene 起播
    if (this.currentTrack === null) return; // 场景尚未起播（如 bgm 关着），仅记录
    if (!s.bgmEnabled) {
      this.stopBgm();
      return;
    }
    // 已在播：音量变化直接改；曲目变化 → 切曲
    if (this.bgm) {
      if (this.resolveBgmFile() !== this.currentTrack) this.startBgm();
      else this.bgm.volume(this.bgmVolume());
    }
  }

  /**
   * 场景切换（路由变化）时调用：按页面氛围映射选定曲目。
   * 氛围页固定映射优先于用户选曲（文档外补充口径）。
   */
  syncScene(pathname: string): void {
    if (!this.settings?.bgmEnabled) return; // bgm_enabled=false 即静默（3.9，含氛围页）
    const file = this.resolveAmbient(pathname) ?? this.resolveBgmFile();
    if (!file) {
      return;
    }
    if (file === this.currentTrack && this.bgm) return;
    this.startBgm(file);
  }

  /** 停止 BGM（登出/静音时） */
  stopBgm(): void {
    if (this.bgm) {
      this.bgm.stop();
      this.bgm.unload();
      this.bgm = null;
    }
    this.currentTrack = null;
  }

  /**
   * 播放一次性音效（独立于 BGM 开关/音量，受 sfx_enabled/sfx_volume 控制）。
   * 未同步过设置时按默认开、音量 80 播放（与设置默认值一致，3.7）。
   */
  playSfx(event: SfxEvent): void {
    const s = this.settings;
    if (s && !s.sfxEnabled) return;
    const vol = ((s?.sfxVolume ?? 80) / 100).toFixed(2);
    let howl = this.sfx.get(event);
    if (!howl) {
      howl = new Howl({ src: [`${this.basePath}sfx/${SFX_FILES[event]}`], volume: Number(vol) });
      this.sfx.set(event, howl);
    } else {
      howl.volume(Number(vol));
    }
    const id = howl.play();
    howl.volume(Number(vol), id);
  }

  /** 停止 BGM 并释放音效实例（登出时调用） */
  dispose(): void {
    this.stopBgm();
    this.sfx.forEach((h) => h.unload());
    this.sfx.clear();
    this.settings = null;
  }

  /**
   * @internal 仅供单测重置单例内部状态（生产代码禁止调用：单例全局唯一）。
   */
  resetForTest(): void {
    this.dispose();
    this.unlockArmed = false;
  }

  // ---------- 内部实现 ----------

  /** 用户设置所选项的文件名；bgm_enabled=false 返回 null（不播） */
  private resolveBgmFile(): string | null {
    if (!this.settings?.bgmEnabled) return null;
    return this.settings.bgmTrack || DEFAULT_TRACK;
  }

  /** 路由 → 氛围曲文件名；非氛围页返回 null；氛围曲不在白名单（文件被删）时回退选曲 */
  private resolveAmbient(pathname: string): string | null {
    let file: string | null = null;
    if (pathname.startsWith('/match/load/')) file = AMBIENT_TRACKS.loading;
    else if (pathname.startsWith('/match/play/')) file = AMBIENT_TRACKS.match;
    else if (pathname.startsWith('/match/result/')) file = AMBIENT_TRACKS.finale;
    if (file === null) return null;
    const tracks = this.settings?.availableTracks;
    if (tracks && tracks.length > 0 && !tracks.includes(file)) {
      // 氛围曲文件被删：回退 bgm_track 所选曲（不报错，README 已注明）
      return this.resolveBgmFile();
    }
    return file;
  }

  /** bgm_enabled=false 时氛围页同样静默 */
  private startBgm(file?: string): void {
    const target = file ?? this.resolveBgmFile();
    if (!target) return;
    this.stopBgm();
    const howl = new Howl({
      src: [`${this.basePath}${target}`],
      loop: true,
      volume: this.bgmVolume(),
      // html5 关闭走 WebAudio 缓冲，切曲无缝；加载失败静默（占位文件缺失不报错）
      onloaderror: () => undefined,
      onplayerror: () => undefined,
    });
    this.bgm = howl;
    this.currentTrack = target;
    const id = howl.play();
    if (id === null || !howl.playing(id)) {
      // 浏览器自动播放受限：挂一次性交互监听，首次 pointerdown/keydown 后重试（3.9）
      this.armUnlock(howl);
    }
  }

  private bgmVolume(): number {
    return Number(((this.settings?.volume ?? 80) / 100).toFixed(2));
  }

  /** 挂一次性 pointerdown/keydown 解锁监听（首次交互后启动被拦截的 BGM） */
  private armUnlock(howl: Howl): void {
    if (this.unlockArmed) return;
    this.unlockArmed = true;
    const unlock = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      this.unlockArmed = false;
      if (this.bgm === howl) howl.play();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }
}


export const AudioManager = new AudioManagerImpl();
