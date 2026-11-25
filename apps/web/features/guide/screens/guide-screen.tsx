'use client';

import { BookMarked, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge, Input, PageHeader } from '@/components/ui';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { usePrograms } from '@/lib/programs-context';
import { ProgramGlyph } from '@/features/platform';
import { GuideText } from '../components/guide-blocks';
import { GUIDE_CONTENT } from '../content';
import { buildGuideIndex } from '../search';
import type { GuideGroup, GuideSection } from '../types';

const GROUPS: readonly GuideGroup[] = ['start', 'tasks', 'programs', 'help'];

/** Hub page /guide: the search box and every section, grouped, in the reader's language. */
export function GuideScreen() {
  const { t, tn, locale } = useI18n();
  const { installed } = usePrograms();
  const content = GUIDE_CONTENT[locale];
  const index = useMemo(() => buildGuideIndex(content, [GUIDE_CONTENT[locale === 'en' ? 'ar' : 'en']]), [content, locale]);
  const [query, setQuery] = useState('');
  const hits = query.trim() ? index.query(query) : null;
  const off = (s: GuideSection) => s.program !== null && !installed(s.program);

  return (
    <>
      <PageHeader icon={<BookMarked className="size-[18px]" aria-hidden />} title={t('guide.title')} description={t('guide.intro')} />
      <div className="mb-6 max-w-xl">
        <label htmlFor="guide-search" className="mb-1.5 block text-xs font-medium text-muted">
          {t('guide.search')}
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input id="guide-search" type="search" className="ps-8" placeholder={t('guide.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {hits ? (
        <section aria-live="polite">
          <p className="mb-3 text-[13px] text-muted">{hits.length ? fill(tn('guide.results', hits.length), { n: hits.length }) : t('guide.searchEmpty')}</p>
          <ul className="space-y-2">
            {hits.map((hit) => {
              const section = content.find((s) => s.id === hit.id)!;
              return (
                <li key={hit.id}>
                  <Link
                    href={`/guide/${hit.id}${hit.anchor ? `#${hit.anchor}` : ''}`}
                    className="block rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-fg">
                      {hit.title}
                      {off(section) && <Badge tone="idle">{t('platform.notInstalled')}</Badge>}
                    </span>
                    <span className="mt-1 block text-[13px] leading-6 text-muted">
                      <GuideText text={hit.snippet} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <div className="space-y-7">
          {GROUPS.map((group) => (
            <section key={group} aria-labelledby={`guide-group-${group}`}>
              <h2 id={`guide-group-${group}`} className="mb-3 text-[15px] font-semibold text-fg">
                {t(`guide.group.${group}` as Key)}
              </h2>
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {content
                  .filter((s) => s.group === group)
                  .map((s) => (
                    <li key={s.id} data-guide-section={s.id} data-off={off(s) || undefined}>
                      <Link
                        href={`/guide/${s.id}`}
                        className="flex h-full min-w-0 items-start gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        {s.program && <ProgramGlyph id={s.program} size={28} />}
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-fg">
                            <bdi>{s.title}</bdi>
                            {off(s) && <Badge tone="idle">{t('platform.notInstalled')}</Badge>}
                          </span>
                          <span className="mt-1 block text-[13px] leading-6 text-muted">{s.summary}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
