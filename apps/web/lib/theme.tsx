'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { THEME_STORAGE_KEY } from './theme-boot';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeCtx {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
  /** Once the signed-in user is known, their own saved choice (if any) wins over the browser's last one. */
  bindUser: (userId: string) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

const read = (key: string): ThemePreference | null => {
  try {
    const v = window.localStorage.getItem(key);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
};
const write = (key: string, value: ThemePreference) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
};
const systemTheme = (): ResolvedTheme => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPref] = useState<ThemePreference>(() => (typeof window !== 'undefined' ? (read(THEME_STORAGE_KEY) ?? 'system') : 'system'));
  const [resolved, setResolved] = useState<ResolvedTheme>(() => (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'));
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const apply = () => {
      const next = preference === 'system' ? systemTheme() : preference;
      document.documentElement.setAttribute('data-theme', next);
      setResolved(next);
    };
    apply();
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [preference]);

  const setPreference = useCallback(
    (p: ThemePreference) => {
      setPref(p);
      write(THEME_STORAGE_KEY, p);
      if (userId) write(`${THEME_STORAGE_KEY}:${userId}`, p);
    },
    [userId],
  );

  const bindUser = useCallback((id: string) => {
    setUserId(id);
    const own = read(`${THEME_STORAGE_KEY}:${id}`);
    if (own) {
      setPref(own);
      write(THEME_STORAGE_KEY, own);
    }
  }, []);

  const value = useMemo(() => ({ preference, resolved, setPreference, bindUser }), [preference, resolved, setPreference, bindUser]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme outside ThemeProvider');
  return ctx;
}
