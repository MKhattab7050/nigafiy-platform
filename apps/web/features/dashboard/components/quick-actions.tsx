'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { FEATURES } from '@/features/registry';
import { useApp } from '@/lib/app';
import { useI18n } from '@/lib/i18n';

/** Shortcuts to the tools that have no summary of their own (registry entries marked `quickAction`). */
export function QuickActions() {
  const { t } = useI18n();
  const { can } = useApp();
  const actions = FEATURES.filter((f) => f.quickAction && (!f.minRole || can(f.minRole)));
  return (
    <section aria-labelledby="quick-title">
      <h2 id="quick-title" className="mb-3 text-[13.5px] font-semibold text-fg">
        {t('overview.quickActions')}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {actions.map(({ id, route, label, icon: Icon }) => (
          <li key={id}>
            <Link
              href={route}
              className="group flex h-full items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 shadow-[var(--shadow-card)] transition-colors hover:border-line-strong hover:bg-raised/50"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-accent/10 text-accent-hover">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{t(label)}</span>
              <ArrowRight className="size-4 text-faint transition-transform duration-[120ms] group-hover:translate-x-0.5 group-hover:text-fg rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
