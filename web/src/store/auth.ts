import { create } from 'zustand';

export interface AuthUser {
  id: number;
  username: string;
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  setAuth: (bundle: TokenBundle, remember: boolean) => void;
  clear: () => void;
}

const STORAGE_KEY = 'dond.auth';

function loadStored(): TokenBundle | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TokenBundle;
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 认证状态（zustand）。
 * 「记住我」→ localStorage（跨浏览器会话保持）；否则 sessionStorage（关闭浏览器即失效）。
 */
export const useAuthStore = create<AuthState>()((set) => ({
  ...(loadStored() ?? { accessToken: null, refreshToken: null, user: null }),
  setAuth: ({ accessToken, refreshToken, user }, remember) => {
    const payload = JSON.stringify({ accessToken, refreshToken, user });
    if (remember) {
      localStorage.setItem(STORAGE_KEY, payload);
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, payload);
      localStorage.removeItem(STORAGE_KEY);
    }
    set({ accessToken, refreshToken, user });
  },
  clear: () => {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    set({ accessToken: null, refreshToken: null, user: null });
  },
}));
