'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { FEATURES } from '@/features/registry';
import { useApp } from '@/lib/app';
import { InstallNote, ProgramGlyph } from '@/features/platform';
import { useI18n } from '@/lib/i18n';
import { programById } from '@/lib/programs';
import { usePrograms } from '@/lib/programs-context';
import { useView } from '@/lib/view';
import { shownIn } from '@/lib/view-mode';

/**
 * Shortcuts to the tools that have no summary of their own (registry entries marked `quickAction`),
 * each with its program. A program that is not installed keeps its tile, with the install note.
 */
export function QuickActions() {
  const { t } = useI18n();
  const { can } = useApp();
  const { installed } = usePrograms();
  const { view } = useView();
  const actions = FEATURES.filter((f) => f.quickAction && shownIn(f, view) && (!f.minRole || can(f.minRole)));
  return (
    <section aria-labelledby="quick-title">
      <h2 id="quick-title" className="mb-3 text-[13.5px] font-semibold text-fg">
        {t('overview.quickActions')}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {actions.map(({ id, route, label, icon: Icon, program }) =>
          !installed(program) ? (
            <li key={id} className="flex h-full flex-col justify-center gap-1.5 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
              <span className="truncate text-[13px] font-medium text-muted">{t(label)}</span>
              <InstallNote program={program} />
            </li>
          ) : (
          <li key={id}>
            <Link
              href={route}
              className="group flex h-full items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 shadow-[var(--shadow-card)] transition-colors hover:border-line-strong hover:bg-raised/50"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-accent/10 text-accent-hover">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">{t(label)}</span>
                <span className="mt-0.5 flex items-center gap-1 text-[11px] text-faint">
                  <ProgramGlyph id={program} size={12} />
                  <bdi>{programById(program).shortName}</bdi>
                </span>
              </span>
              <ArrowRight className="size-4 text-faint transition-transform duration-[120ms] group-hover:translate-x-0.5 group-hover:text-fg rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" aria-hidden />
            </Link>
          </li>
          ),
        )}
      </ul>
    </section>
  );
}
