'use client';

import type { PlatformProgramsResponse } from '@nigafiy/shared-types/programs';
import clsx from 'clsx';
import { ArrowRight, LayoutGrid } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';
import { Badge, ErrorNote, PageHeader, SkeletonBlock } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { PROGRAM_REGISTRY } from '@/lib/programs';
import { ProgramGlyph } from '../components/programs-strip';

/**
 * Hub, Programs: every Nigafiy program with its job, the pages it contains and whether this install
 * offers it (GET /platform/programs). "Install" anywhere in the app leads here (`/programs#<id>`): a
 * program that is not installed says why and how to get it.
 */
export function ProgramsScreen() {
  const { t, locale } = useI18n();
  const query = useQuery<PlatformProgramsResponse>('/platform/programs', [], 300_000);
  const items = query.data?.items ?? null;

  // The page renders after the session loads, so the browser's own #<program> jump finds nothing; do it once data is here.
  useEffect(() => {
    if (!items) return;
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(`program-${id}`)?.scrollIntoView({ block: 'start' });
  }, [items]);

  return (
    <>
      <PageHeader icon={<LayoutGrid className="size-[18px]" aria-hidden />} title={t('platform.programs.title')} description={t('platform.programs.intro')} />
      {query.error && !items && (
        <div className="mb-4 space-y-2">
          <p className="text-[13px] text-warn">{t('platform.programs.loadError')}</p>
          <ErrorNote error={query.error} onRetry={query.reload} />
        </div>
      )}
      {!items && !query.error ? (
        <SkeletonBlock lines={6} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {PROGRAM_REGISTRY.map((p) => {
            const served = items?.find((x) => x.id === p.id);
            // Without an answer every program counts as available (bundled installs), as the shell does.
            const installed = served ? served.installed : true;
            return (
              <li
                key={p.id}
                id={`program-${p.id}`}
                className={clsx(
                  'flex min-w-0 scroll-mt-20 flex-col rounded-[var(--radius-card)] border bg-surface p-4 shadow-[var(--shadow-card)] target:ring-2 target:ring-accent',
                  installed ? 'border-line' : 'border-line-strong',
                )}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <ProgramGlyph id={p.id} size={40} />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[15px] font-semibold text-fg">
                      <bdi>{p.name[locale]}</bdi>
                    </h2>
                    <p className="mt-0.5 text-[13px] text-muted">{p.job[locale]}</p>
                  </div>
                  {installed ? <Badge tone="ok">{t('platform.programs.installed')}</Badge> : <Badge tone="idle">{t('platform.notInstalled')}</Badge>}
                </div>
                <div className="mt-3">
                  <h3 className="mb-1.5 text-xs font-medium text-muted">{t('platform.programs.pages')}</h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {p.sections.map((s) => {
                      const Icon = s.icon;
                      return (
                        <li key={s.id} className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-line bg-raised/50 px-2 text-xs text-fg">
                          <Icon className="size-3.5 text-faint" aria-hidden />
                          {t(s.label)}
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div className="mt-auto pt-4">
                  {installed ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <Link
                        href={p.home}
                        aria-label={`${t('platform.open')} ${p.name[locale]}`}
                        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-on-accent hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {t('platform.open')}
                        <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
                      </Link>
                      {served?.install_source === 'bundled' && <span className="text-xs text-faint">{t('platform.bundled')}</span>}
                    </div>
                  ) : (
                    <div className="space-y-1.5 rounded-[var(--radius-control)] border border-line bg-raised/40 px-3 py-2.5 text-xs leading-relaxed">
                      <p className="text-muted">{t('platform.programs.leftOut')}</p>
                      <p className="text-fg">{t('platform.programs.howToInstall')}</p>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
