'use client';

import { useRouter } from 'next/navigation';
import { createContext, startTransition, useCallback, useContext, useEffect, useMemo } from 'react';
import type { Key, Locale, Messages } from './dictionary';

export type { Key, Locale };

interface I18n {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: (key: Key) => string;
  setLocale: (locale: Locale) => void;
}

const Ctx = createContext<I18n | null>(null);

/**
 * `messages` is the active language only, passed down by the root layout (a Server Component), so
 * the dictionaries never ship as client JavaScript. Switching language sets the cookie and refreshes
 * the server tree, which re-renders the root layout with the other language (client state is kept).
 */
export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Messages; children: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  const setLocale = useCallback(
    (next: Locale) => {
      // Cookie so the server renders the right language and direction (no flash of LTR).
      document.cookie = `ld_locale=${next}; path=/; max-age=31536000; samesite=lax`;
      startTransition(() => router.refresh());
    },
    [router],
  );

  const value = useMemo<I18n>(() => ({ locale, dir: locale === 'ar' ? 'rtl' : 'ltr', setLocale, t: (key) => messages[key] ?? key }), [locale, setLocale, messages]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

/** Fills `{name}` placeholders in a translated sentence. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
