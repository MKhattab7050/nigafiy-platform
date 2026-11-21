'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { type Key, type Locale, dictionaries } from './dictionary';

export type { Key, Locale };

interface I18n {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: (key: Key) => string;
  setLocale: (locale: Locale) => void;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    // Cookie so the server renders the right direction on the next full load (no flash of LTR).
    document.cookie = `ld_locale=${next}; path=/; max-age=31536000; samesite=lax`;
    setLocaleState(next);
  }, []);

  const value = useMemo<I18n>(
    () => ({ locale, dir: locale === 'ar' ? 'rtl' : 'ltr', setLocale, t: (key) => dictionaries[locale][key] ?? dictionaries.en[key] ?? key }),
    [locale, setLocale],
  );
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
