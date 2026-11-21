'use client';

import type { PlatformProgramsResponse, ProgramId } from '@lan-detective/shared-types/programs';
import { PROGRAMS_BRAND } from '@nigafiy/brand';
import Link from 'next/link';
import { Async, Card, SkeletonBlock } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';
import { installHref } from '@/lib/programs';

/** A program's glyph on its accent square, from @nigafiy/brand (the approved icon set). */
export function ProgramGlyph({ id, size = 36 }: { id: ProgramId; size?: number }) {
  const brand = PROGRAMS_BRAND[id];
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[25%]" style={{ width: size, height: size, background: brand.accent }} aria-hidden>
      <svg aria-hidden="true" width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={size <= 24 ? 2.4 : 2} strokeLinecap="round" strokeLinejoin="round">
        <path d={brand.glyph} />
      </svg>
    </span>
  );
}

/** Hub home: one tile per program, opening it on its own job (spec §6.2). */
export function ProgramsStrip() {
  const { t, locale } = useI18n();
  const programs = useQuery<PlatformProgramsResponse>('/platform/programs', [], 300_000);
  return (
    <Card title={t('platform.programs')} description={t('platform.programsHint')}>
      <Async query={programs} skeleton={<SkeletonBlock lines={2} />}>
        {(data) => (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.items
              .filter((p) => p.id !== 'hub')
              .map((p) => (
                <li key={p.id} className="flex min-w-0 items-start gap-3 rounded-[10px] border border-line bg-raised/40 p-3">
                  <ProgramGlyph id={p.id} />
                  <div className="min-w-0 flex-1">
                    {/* The family name is on the card; the tile shows the program's own name. */}
                    <p className="truncate text-[13.5px] font-semibold text-fg" title={p.name[locale]}>
                      <bdi>{p.name[locale].replace(/^Nigafiy\s+/, '')}</bdi>
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{p.job[locale]}</p>
                    <div className="mt-2 flex items-center gap-2">
                      {p.installed ? (
                        <Link
                          href={p.home}
                          className="inline-flex h-7 items-center rounded-[var(--radius-control)] border border-line-strong px-2.5 text-xs font-medium text-fg hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent"
                          aria-label={`${t('platform.open')} ${p.name[locale]}`}
                        >
                          {t('platform.open')}
                        </Link>
                      ) : (
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                          {t('platform.notInstalled')}
                          <Link href={installHref(p.id)} aria-label={fill(t('platform.installAria'), { name: p.name[locale] })} className="font-medium text-accent-hover hover:underline">
                            {t('platform.install')}
                          </Link>
                        </span>
                      )}
                      {p.install_source === 'bundled' && <span className="truncate text-[11px] text-faint">{t('platform.bundled')}</span>}
                    </div>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </Async>
    </Card>
  );
}
