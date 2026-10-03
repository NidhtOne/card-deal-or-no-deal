import { api } from './client';
import { blobExt } from '../utils/image';

/** GET /api/user/profile 返回结构（docs/开发文档.md 6.2） */
export interface Profile {
  username: string;
  nickname: string | null;
  signature: string | null;
  avatarUrl: string | null;
  characterUrl: string | null;
  bankerCharacterUrl: string | null;
  usernameChangedAt: string | null;
}

/**
 * GET /api/user/overview 返回结构（文档外补充）。
 * 签到/破产救助字段为真实值；统计三项（totalMatches/totalProfit/winRate）
 * 与 GET /api/history/stats 同源（3.10，M5 阶段 7 起接入真实值）。
 */
export interface Overview {
  balance: number;
  todaySignedIn: boolean;
  signinStreakDays: number;
  todayBailoutUsed: number;
  /** 余额 < 破产救助门槛（3.8.4；大厅入口高亮依据，数值禁止前端硬编码） */
  bailoutEligible: boolean;
  /** 破产救助每日上限（config/economy.json） */
  bailoutMaxPerDay: number;
  totalMatches: number;
  totalProfit: number;
  winRate: number;
}

/** GET /api/user/settings 返回结构（3.7 的 8 个设置字段 + 曲目白名单） */
export interface Settings {
  bgmEnabled: boolean;
  bgmTrack: string;
  volume: number;
  sfxEnabled: boolean;
  sfxVolume: number;
  amountListEnabled: boolean;
  riskPopupEnabled: boolean;
  achievementEnabled: boolean;
  availableTracks: string[];
}

export type UpdateSettingsPayload = Partial<Omit<Settings, 'availableTracks'>>;

/** GET /api/user/character/history 返回结构（文档外补充） */
export interface CharacterHistory {
  activeUrl: string | null;
  items: { id: number; url: string; createdAt: string }[];
}

/** GET /api/user/banker-options 返回结构（文档外补充） */
export interface BankerOptions {
  builtin: { filename: string; url: string }[];
  currentUrl: string | null;
  defaultUrl: string | null;
}

export const userApi = {
  getProfile: () => api.get<Profile>('/user/profile').then((r) => r.data),
  updateProfile: (payload: { username?: string; nickname?: string; signature?: string }) =>
    api.put<Profile>('/user/profile', payload).then((r) => r.data),
  getSettings: () => api.get<Settings>('/user/settings').then((r) => r.data),
  updateSettings: (payload: UpdateSettingsPayload) =>
    api.put<Settings>('/user/settings', payload).then((r) => r.data),
  getOverview: () => api.get<Overview>('/user/overview').then((r) => r.data),
  getCharacterHistory: () =>
    api.get<CharacterHistory>('/user/character/history').then((r) => r.data),
  activateCharacter: (id: number) =>
    api.post<{ url: string }>(`/user/character/${id}/activate`).then((r) => r.data),
  getBankerOptions: () => api.get<BankerOptions>('/user/banker-options').then((r) => r.data),
  selectBuiltinBanker: (filename: string) =>
    api.post<{ url: string }>('/user/banker-character', { filename }).then((r) => r.data),
};

/** multipart 上传（字段名 file），onProgress 0-100 */
export async function uploadImage(
  path: '/user/avatar' | '/user/character' | '/user/banker-character',
  blob: Blob,
  onProgress: (percent: number) => void,
): Promise<{ url: string }> {
  const form = new FormData();
  form.append('file', blob, `upload.${blobExt(blob)}`);
  const { data } = await api.post<{ url: string }>(path, form, {
    onUploadProgress: (e) => {
      if (e.total) onProgress(Math.round((e.loaded * 100) / e.total));
    },
  });
  return data;
}
