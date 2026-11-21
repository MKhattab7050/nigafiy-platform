'use client';

import clsx from 'clsx';
import { ArrowRight, BellRing } from 'lucide-react';
import { AllClearArt } from '@/components/illustrations';
import { SkeletonBlock, ToneIcon } from '@/components/ui';
import { ButtonLink } from '@/components/widget';
import { ProgramGlyph } from '@/features/platform';
import { type AttentionItem, useAttentionReports } from '@/lib/attention';
import { fill, useI18n } from '@/lib/i18n';
import { programById, programOfFeature } from '@/lib/programs';

const RANK: Record<AttentionItem['tone'], number> = { crit: 0, warn: 1, info: 2 };
const EDGE: Record<AttentionItem['tone'], string> = { crit: 'before:bg-crit', warn: 'before:bg-warn', info: 'before:bg-accent' };

/**
 * "Needs your attention", worked out from what the widgets below already loaded. Each item is a
 * shortcut to the page that resolves it; nothing is done automatically.
 */
export function AttentionPanel({ expected }: { expected: string[] }) {
  const { t, locale } = useI18n();
  const byId = useAttentionReports();
  const reports = Object.values(byId);
  // Each item carries the program that owns the widget it came from (shared notifications, spec §5).
  const items = Object.entries(byId)
    .flatMap(([source, r]) => (r.state === 'ready' ? r.items.map((item) => ({ ...item, program: programById(programOfFeature(source)) })) : []))
    .sort((a, b) => RANK[a.tone] - RANK[b.tone]);
  // Still checking until every widget that reports has answered (a lazily loaded one may not have mounted yet).
  const loading = expected.some((id) => !byId[id]) || reports.some((r) => r.state === 'loading');
  const failed = reports.some((r) => r.state === 'error');
  const crit = items.filter((i) => i.tone === 'crit').length;

  return (
    <section className="flex h-full min-w-0 flex-col rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]" aria-labelledby="attention-title">
      <header className="flex min-h-12 items-center gap-2.5 border-b border-line px-4 py-2.5">
        <span className={clsx('flex size-7 items-center justify-center rounded-[7px]', crit ? 'bg-crit/12 text-crit' : 'bg-accent/12 text-accent-hover')}>
          <BellRing className="size-[15px]" aria-hidden />
        </span>
        <h2 id="attention-title" className="text-[13.5px] font-semibold text-fg">
          {t('overview.attention')}
        </h2>
        {items.length > 0 && <span className="tnum inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-raised px-1 text-[11px] font-semibold text-muted">{items.length}</span>}
      </header>
      {items.length > 0 && (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li
              key={item.id}
              className={clsx(
                'relative flex flex-wrap items-center gap-x-3 gap-y-2 py-3 pe-4 ps-5 before:absolute before:inset-y-2.5 before:start-0 before:w-[3px] before:rounded-e-full',
                EDGE[item.tone],
              )}
            >
              <ToneIcon tone={item.tone} className="size-4" />
              <p className="min-w-0 flex-1 basis-56 text-[13px] leading-relaxed text-fg" dir="auto">
                <span className="sr-only">{t(item.tone === 'crit' ? 'severity.critical' : item.tone === 'warn' ? 'severity.warning' : 'severity.info')}: </span>
                {item.text}
                {item.program.id !== 'hub' && (
                  <span className="ms-2 inline-flex items-center gap-1 align-middle text-[11px] text-faint" title={fill(t('platform.from'), { name: item.program.name[locale] })}>
                    <ProgramGlyph id={item.program.id} size={12} />
                    <bdi>{item.program.shortName}</bdi>
                  </span>
                )}
              </p>
              <ButtonLink href={item.action.href} variant={item.tone === 'crit' ? 'primary' : 'secondary'}>
                {item.action.label}
                <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
              </ButtonLink>
            </li>
          ))}
        </ul>
      )}
      {loading ? (
        <div className="px-4 py-3">
          <p className="mb-2 text-xs text-muted">{t('overview.attentionChecking')}</p>
          {items.length === 0 && <SkeletonBlock lines={3} />}
        </div>
      ) : items.length === 0 && !failed ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 text-center">
          <AllClearArt className="h-16 w-32 text-faint" />
          <p className="mt-3 text-[13px] font-medium text-fg">{t('overview.attentionNone')}</p>
        </div>
      ) : null}
      {!loading && failed && <p className="mt-auto border-t border-line px-4 py-2.5 text-xs text-warn">{t('overview.attentionPartial')}</p>}
    </section>
  );
}
