'use client';

import { useEffect, useState } from 'react';
import { THEME_STORAGE_KEY } from '@/lib/theme-boot';
import './globals.css';

// The root layout itself failed, so there is no I18nProvider or theme boot script here: this page
// carries its own two-language text and reads the locale cookie and theme preference after mount.
const TEXT = {
  en: {
    title: 'Nigafiy could not open this page',
    body: 'Something failed while the page was starting. Your data is unchanged. Try again, or reload the page.',
    retry: 'Try again',
    reload: 'Reload the page',
  },
  ar: {
    title: 'تعذّر على Nigafiy فتح هذه الصفحة',
    body: 'حدث خطأ أثناء بدء الصفحة. بياناتك لم تتغيّر. أعد المحاولة، أو أعد تحميل الصفحة.',
    retry: 'أعد المحاولة',
    reload: 'إعادة تحميل الصفحة',
  },
} as const;

export default function GlobalError({ error, retry }: { error: unknown; retry?: () => void }) {
  const [locale, setLocale] = useState<'en' | 'ar'>('en');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  useEffect(() => {
    console.error(error);
    if (/(?:^|;\s*)ld_locale=ar(?:;|$)/.test(document.cookie)) setLocale('ar');
    let pref: string | null = null;
    try {
      pref = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      /* storage blocked */
    }
    const system = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    setTheme(pref === 'light' || pref === 'dark' ? pref : system);
  }, [error]);
  const s = TEXT[locale];
  const digest = error && typeof error === 'object' && 'digest' in error ? String((error as { digest?: unknown }).digest ?? '') : '';
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} data-theme={theme} suppressHydrationWarning>
      <body className="min-h-dvh text-sm">
        <title>Nigafiy</title>
        <main className="flex min-h-dvh items-center justify-center px-4">
          <div role="alert" className="w-full max-w-md rounded-[12px] border border-line-strong bg-surface p-6 text-center">
            <h1 className="text-[15px] font-semibold text-fg">{s.title}</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{s.body}</p>
            {digest && (
              <p className="mono mt-2 text-[11px] text-faint" dir="ltr">
                {digest}
              </p>
            )}
            <div className="mt-5 flex justify-center gap-2">
              {retry && (
                <button type="button" onClick={retry} className="inline-flex h-9 items-center rounded-[var(--radius-control)] border border-transparent bg-accent px-4 text-[13px] font-medium text-on-accent hover:bg-accent-strong">
                  {s.retry}
                </button>
              )}
              <button type="button" onClick={() => window.location.reload()} className="inline-flex h-9 items-center rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 text-[13px] text-fg hover:bg-raised">
                {s.reload}
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
