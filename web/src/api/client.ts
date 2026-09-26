import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { TokenBundle, useAuthStore } from '../store/auth';

export const api = axios.create({ baseURL: '/api' });

/** 请求拦截器：自动携带 Access Token */
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** 单飞行 Refresh：并发 401 只触发一次刷新 */
let refreshing: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const { refreshToken, setAuth, clear } = useAuthStore.getState();
  if (!refreshToken) return false;
  try {
    const { data } = await axios.post<TokenBundle>('/api/auth/refresh', { refreshToken });
    // 沿用原有存储介质：localStorage 有记录说明登录时勾选了「记住我」
    setAuth(data, localStorage.getItem('dond.auth') !== null);
    return true;
  } catch {
    clear();
    return false;
  }
}

/** 响应拦截器：Access 过期（401）自动 Refresh 并重放原请求；Refresh 失败跳登录页 */
api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const url = original?.url ?? '';
    // 认证接口自身的 401（如登录密码错误、Refresh 重放）直接透传，不做刷新
    const isAuthApi = url.includes('/auth/');
    if (error.response?.status === 401 && original && !original._retried && !isAuthApi) {
      original._retried = true;
      refreshing = refreshing ?? doRefresh().finally(() => (refreshing = null));
      const ok = await refreshing;
      if (ok) return api(original);
      if (window.location.pathname !== '/login') window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

/** 从 Axios 错误中提取后端 message（class-validator 返回数组） */
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string | string[] } | undefined;
    if (data?.message) return Array.isArray(data.message) ? data.message[0] : data.message;
  }
  return '网络错误，请稍后重试';
}

/** 提取账号锁定剩余秒数（登录接口 423 响应） */
export function getLockedSeconds(error: unknown): number | null {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { lockedSeconds?: number } | undefined;
    if (typeof data?.lockedSeconds === 'number') return data.lockedSeconds;
  }
  return null;
}
