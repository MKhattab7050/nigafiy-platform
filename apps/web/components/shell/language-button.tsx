'use client';

import clsx from 'clsx';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** Switches English ⇄ Arabic, remembered for the signed-in user. In the top bar, and in the phone menu drawer. */
export function LanguageButton({ className }: { className?: string }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <button
      type="button"
      onClick={() => {
        const next = locale === 'en' ? 'ar' : 'en';
        setLocale(next);
        void api('/auth/me', { method: 'PATCH', body: { locale: next } }).catch(() => undefined);
      }}
      className={clsx('h-8 rounded-[var(--radius-control)] border border-line-strong px-2.5 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-fg', className)}
      aria-label={t('settings.language')}
      lang={locale === 'en' ? 'ar' : 'en'}
    >
      {locale === 'en' ? 'العربية' : 'English'}
    </button>
  );
}
