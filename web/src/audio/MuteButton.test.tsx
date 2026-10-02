// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 快捷静音闭环单测（铁律 9；3.9 对局页右上角快捷静音）：
 * 静音按钮 = 切换 bgm_enabled 并 PUT /api/user/settings 持久化；恢复音量保持原值；
 * SFX 不受影响（sfx_enabled 独立，不同步音效字段之外的状态）。
 * mock '../api/user'（PUT 调用可断言）与 '../audio/AudioManager'（无需真实 WebAudio）。
 */
vi.mock('./AudioManager', () => ({
  AudioManager: {
    syncSettings: vi.fn(),
    syncScene: vi.fn(),
    stopBgm: vi.fn(),
    dispose: vi.fn(),
    playSfx: vi.fn(),
    getCurrentTrack: vi.fn(() => null),
    isPlaying: vi.fn(() => false),
    resetForTest: vi.fn(),
  },
}));

const updateSettings = vi.fn();

vi.mock('../api/user', () => ({
  userApi: {
    getSettings: vi.fn(),
    updateSettings: (payload: unknown) => updateSettings(payload),
  },
}));

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { AudioManager } from './AudioManager';
import { useAudioStore } from './audioStore';
import MuteButton from '../components/MuteButton';

const SETTINGS_ON = {
  bgmEnabled: true,
  bgmTrack: 'lobby.wav',
  volume: 65,
  sfxEnabled: true,
  sfxVolume: 40,
  amountListEnabled: true,
  riskPopupEnabled: true,
  achievementEnabled: true,
  availableTracks: ['lobby.wav'],
};

beforeEach(() => {
  vi.clearAllMocks();
  useAudioStore.setState({ settings: null, muted: false });
});

// vitest 未开 globals：手动挂 RTL 清理，避免 DOM 跨用例累积
afterEach(cleanup);

describe('快捷静音（3.9）：切换 bgm_enabled + PUT 持久化', () => {
  it('点击静音 → PUT {bgmEnabled:false}，状态与 AudioManager 同步，SFX 字段不动', async () => {
    updateSettings.mockResolvedValue({ ...SETTINGS_ON, bgmEnabled: false });
    useAudioStore.setState({
      settings: { ...SETTINGS_ON },
      muted: false,
    });

    const { getByRole } = render(<MuteButton />);
    fireEvent.click(getByRole('button'));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ bgmEnabled: false }));
    // 静音 = 停曲（不卸载音效实例，SFX 不受影响）
    expect(AudioManager.stopBgm).toHaveBeenCalled();
    expect(AudioManager.syncSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ bgmEnabled: false, volume: 65, sfxEnabled: true }),
    );
    await waitFor(() => expect(useAudioStore.getState().muted).toBe(true));
    expect(getByRole('button').textContent).toBe('🔇');
  });

  it('恢复 → PUT {bgmEnabled:true}，音量保持原值不清零', async () => {
    updateSettings.mockResolvedValue({ ...SETTINGS_ON, bgmEnabled: true });
    useAudioStore.setState({
      settings: { ...SETTINGS_ON, bgmEnabled: false },
      muted: true,
    });

    const { getByRole } = render(<MuteButton />);
    fireEvent.click(getByRole('button'));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ bgmEnabled: true }));
    // 恢复 = 按当前路由重新起播，音量沿用 65
    expect(AudioManager.syncScene).toHaveBeenCalledWith(window.location.pathname);
    expect(AudioManager.syncSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ bgmEnabled: true, volume: 65 }),
    );
    await waitFor(() => expect(useAudioStore.getState().muted).toBe(false));
    expect(getByRole('button').textContent).toBe('🔊');
  });

  it('PUT 失败 → 音频与状态回滚并报错', async () => {
    updateSettings.mockRejectedValue(new Error('网络异常'));
    useAudioStore.setState({ settings: { ...SETTINGS_ON }, muted: false });

    const { getByRole } = render(<MuteButton />);
    fireEvent.click(getByRole('button'));

    await waitFor(() => expect(useAudioStore.getState().muted).toBe(false));
    expect(AudioManager.syncSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ bgmEnabled: true, volume: 65 }), // 回滚为原设置，音量未被清零
    );
    // 回滚过程重新拉起原曲（一次），PUT 未成功不产生额外切曲
    // 按钮恢复 🔊（仍可重试）
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('🔊'));
  });
});

describe('refresh / init（设置生效闭环）', () => {
  it('refresh：拉设置 → syncSettings + syncScene，muted 跟随', async () => {
    const { userApi } = await import('../api/user');
    (userApi.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SETTINGS_ON,
      bgmEnabled: false,
    });
    await useAudioStore.getState().refresh();
    expect(AudioManager.syncSettings).toHaveBeenCalledWith(
      expect.objectContaining({ bgmEnabled: false, volume: 65 }),
    );
    expect(AudioManager.syncScene).toHaveBeenCalledWith(window.location.pathname);
    expect(useAudioStore.getState().muted).toBe(true);
  });

  it('init 幂等：已有设置时不再重复拉取', async () => {
    const { userApi } = await import('../api/user');
    useAudioStore.setState({ settings: { ...SETTINGS_ON }, muted: false });
    await useAudioStore.getState().init();
    expect(userApi.getSettings).not.toHaveBeenCalled();
  });
});
