// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * SettingsPage「对局历史保留时长」下拉测试
 * 【文档外补充：2026-10-03 人工决策落地】（M8：/history 过期清理的设置项）：
 * - 选项从服务端 historyRetentionOptionsDays 渲染（铁律 7：前端禁止硬编码数值），
 *   文案映射：0=永久保留、其余「N 天」；
 * - 修改后保存 → PUT /api/user/settings 携带 historyRetentionDays，回显更新；
 * - 服务端拒绝非法值（400 文案）时展示错误、不提示保存成功。
 * 全部 API/音频模块 mock。
 */
vi.mock('../api/user', () => ({
  userApi: { getSettings: vi.fn(), updateSettings: vi.fn() },
}));
vi.mock('../audio/audioStore', () => ({
  useAudioStore: (selector: (s: { refresh: () => Promise<void> }) => unknown) =>
    selector({ refresh: () => Promise.resolve() }),
}));

import { Settings, userApi } from '../api/user';
import SettingsPage from './SettingsPage';

const BASE: Settings = {
  bgmEnabled: true,
  bgmTrack: 'lobby.wav',
  volume: 60,
  sfxEnabled: true,
  sfxVolume: 80,
  amountListEnabled: true,
  riskPopupEnabled: true,
  achievementEnabled: true,
  availableTracks: ['lobby.wav'],
  historyRetentionDays: 0,
  historyRetentionOptionsDays: [0, 7, 30, 90, 365],
};

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe('SettingsPage：对局历史保留时长下拉（M8 文档外补充）', () => {
  it('选项与文案从服务端白名单映射渲染（0=永久保留，其余「N 天」），默认值回显', async () => {
    (userApi.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(BASE);
    renderPage();
    const select = (await waitFor(() =>
      screen.getByLabelText('对局历史保留时长'),
    )) as HTMLSelectElement;
    expect(select.value).toBe('0');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      '永久保留',
      '7 天',
      '30 天',
      '90 天',
      '365 天',
    ]);
    expect(screen.getByText('永久保留')).toBeTruthy();
  });

  it('切换为 30 天并保存 → PUT 携带 historyRetentionDays=30，保存成功回显', async () => {
    (userApi.getSettings as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(BASE)
      .mockResolvedValueOnce({ ...BASE, historyRetentionDays: 30 });
    (userApi.updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...BASE,
      historyRetentionDays: 30,
    });
    renderPage();
    const select = (await waitFor(() =>
      screen.getByLabelText('对局历史保留时长'),
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '30' } });
    fireEvent.click(screen.getByText('保存设置'));
    await waitFor(() => expect(screen.getByText('设置已保存')).toBeTruthy());
    expect(userApi.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ historyRetentionDays: 30 }),
    );
    // 保存成功后回显 30
    expect((screen.getByLabelText('对局历史保留时长') as HTMLSelectElement).value).toBe('30');
  });

  it('服务端拒绝非法值（如白名单外）→ 展示错误文案，不提示保存成功', async () => {
    (userApi.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue(BASE);
    (userApi.updateSettings as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { data: { message: '对局历史保留天数非法（可选：0/7/30/90/365，0=永久保留）' } },
    });
    renderPage();
    await waitFor(() => screen.getByLabelText('对局历史保留时长'));
    fireEvent.click(screen.getByText('保存设置'));
    await waitFor(() =>
      expect(
        screen.getByText('对局历史保留天数非法（可选：0/7/30/90/365，0=永久保留）'),
      ).toBeTruthy(),
    );
    expect(screen.queryByText('设置已保存')).toBeNull();
  });
});
