import { create } from 'zustand';
import { userApi } from '../api/user';
import { AudioManager, type AudioSettings } from './AudioManager';

/**
 * 音频生效闭环 store（阶段 6：设置 → 播放，3.9）。
 *
 * 【文档外补充】store + 单例 AudioManager 的组合口径：
 * - init()：登录后由 AudioController 挂载时调用一次（拉设置 → 同步音频 → 按当前路由起播）；
 *   设置页保存后由 SettingsPage 调用刷新生效（音量实时、选曲/开关即时切）。
 * - toggleBgmMuted()：对局页右上角快捷静音（3.9）【钦定语义：按钮 = 切换 bgm_enabled】，
 *   点击静音 → bgm_enabled=false 并 PUT /api/user/settings 持久化；恢复 → true，
 *   音量保持原值不清零；SFX 不受该按钮影响（sfx_enabled 独立）。
 */

/** Settings（API 8 字段）→ AudioManager 快照 */
function toSnapshot(s: Awaited<ReturnType<typeof userApi.getSettings>>): AudioSettings {
  return {
    bgmEnabled: s.bgmEnabled,
    bgmTrack: s.bgmTrack,
    volume: s.volume,
    sfxEnabled: s.sfxEnabled,
    sfxVolume: s.sfxVolume,
    availableTracks: s.availableTracks,
  };
}

interface AudioStore {
  /** 最近一次同步的设置快照（null = 尚未初始化） */
  settings: AudioSettings | null;
  /** bgm_enabled 取反（快捷静音按钮状态；sfx 独立不在此列） */
  muted: boolean;
  init: () => Promise<void>;
  /** 刷新设置并同步音频（设置页保存后调用，音量/选曲实时生效） */
  refresh: () => Promise<void>;
  /** 快捷静音：切换 bgm_enabled + PUT 持久化（失败回滚本地状态） */
  toggleBgmMuted: () => Promise<void>;
}

export const useAudioStore = create<AudioStore>()((set, get) => ({
  settings: null,
  muted: false,

  init: async () => {
    if (get().settings) return; // 幂等：AudioController 重复挂载只拉一次
    await get().refresh();
  },

  refresh: async () => {
    const s = await userApi.getSettings();
    const snap = toSnapshot(s);
    AudioManager.syncSettings(snap);
    set({ settings: snap, muted: !s.bgmEnabled });
    AudioManager.syncScene(window.location.pathname);
  },

  toggleBgmMuted: async () => {
    const prev = get().settings;
    const next = !(prev?.bgmEnabled ?? true);
    // 乐观更新：先本地切状态与音频，PUT 失败再回滚（静音是即时反馈操作）
    AudioManager.syncSettings({
      bgmEnabled: next,
      bgmTrack: prev?.bgmTrack ?? '',
      volume: prev?.volume ?? 80,
      sfxEnabled: prev?.sfxEnabled ?? true,
      sfxVolume: prev?.sfxVolume ?? 80,
      availableTracks: prev?.availableTracks,
    });
    if (next) AudioManager.syncScene(window.location.pathname);
    else AudioManager.stopBgm();
    set({ muted: !next, settings: prev ? { ...prev, bgmEnabled: next } : null });
    try {
      await userApi.updateSettings({ bgmEnabled: next });
    } catch {
      // 持久化失败回滚：音频与状态还原（下次进站仍按服务端设置）
      if (prev) {
        AudioManager.syncSettings(prev);
        if (prev.bgmEnabled) AudioManager.syncScene(window.location.pathname);
        else AudioManager.stopBgm();
        set({ settings: prev, muted: !prev.bgmEnabled });
      }
      throw new Error('静音设置保存失败，请重试');
    }
  },
}));
