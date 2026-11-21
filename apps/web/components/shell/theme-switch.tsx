'use client';

import clsx from 'clsx';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { type ThemePreference, useTheme } from '@/lib/theme';

const OPTIONS: { value: ThemePreference; icon: typeof Sun; key: 'theme.system' | 'theme.light' | 'theme.dark' }[] = [
  { value: 'system', icon: Monitor, key: 'theme.system' },
  { value: 'light', icon: Sun, key: 'theme.light' },
  { value: 'dark', icon: Moon, key: 'theme.dark' },
];

/** System / light / dark, remembered in this browser and for the signed-in user. */
export function ThemeSwitch() {
  const { t } = useI18n();
  const { preference, setPreference } = useTheme();
  return (
    <div role="radiogroup" aria-label={t('theme.label')} className="flex h-8 items-center rounded-[var(--radius-control)] border border-line-strong bg-sunken p-0.5">
      {OPTIONS.map(({ value, icon: Icon, key }) => {
        const on = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={t(key)}
            title={t(key)}
            onClick={() => setPreference(value)}
            className={clsx('flex size-[26px] items-center justify-center rounded-[5px] transition-colors duration-[120ms]', on ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--color-line-strong)]' : 'text-faint hover:text-fg')}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
