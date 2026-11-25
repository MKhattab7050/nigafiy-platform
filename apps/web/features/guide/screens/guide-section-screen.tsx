'use client';

import { ArrowLeft, ArrowRight, BookMarked } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { usePrograms } from '@/lib/programs-context';
import { InstallNote, ProgramGlyph } from '@/features/platform';
import { GuideBlocks } from '../components/guide-blocks';
import { GUIDE_CONTENT } from '../content';

const LINK =
  'inline-flex items-center gap-1.5 rounded-[var(--radius-control)] text-[13px] font-medium text-accent-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** Hub page /guide/<section>: one section of the guide in the reader's language. */
export function GuideSectionScreen({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const { installed } = usePrograms();
  const content = GUIDE_CONTENT[locale];
  const i = content.findIndex((s) => s.id === id);
  const section = content[i];

  // The page renders after the session loads, so the browser's own #anchor jump finds nothing; do it once here.
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
  }, []);

  if (!section) {
    return (
      <>
        <PageHeader icon={<BookMarked className="size-[18px]" aria-hidden />} title={t('guide.title')} />
        <EmptyState title={t('guide.notFound')} action={<Link href="/guide" className={LINK}>{t('guide.back')}</Link>} />
      </>
    );
  }

  const prev = content[i - 1];
  const next = content[i + 1];
  const off = section.program !== null && !installed(section.program);
  const headings = section.blocks.flatMap((b) => (b.kind === 'h' ? [b] : []));

  return (
    <>
      <Link href="/guide" className={`${LINK} mb-4`}>
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {t('guide.back')}
      </Link>
      <PageHeader icon={section.program ? <ProgramGlyph id={section.program} size={24} /> : <BookMarked className="size-[18px]" aria-hidden />} title={section.title} description={section.summary} />
      {off && section.program && (
        <div data-guide-off className="mb-5 space-y-1.5 rounded-[var(--radius-control)] border border-line-strong bg-raised/40 px-3 py-2.5 text-[13px]">
          <p className="text-muted">{t('guide.notInstalledNote')}</p>
          <InstallNote program={section.program} />
        </div>
      )}
      <div className="flex flex-col gap-8 lg:flex-row-reverse lg:items-start">
        {headings.length > 1 && (
          <nav aria-labelledby="guide-toc" className="lg:sticky lg:top-20 lg:w-56 lg:shrink-0">
            <h2 id="guide-toc" className="mb-2 text-xs font-medium text-muted">
              {t('guide.onThisPage')}
            </h2>
            <ul className="space-y-1 border-s border-line ps-3 text-[13px]">
              {headings.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} className="text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <article className="min-w-0 max-w-3xl flex-1">
          <GuideBlocks blocks={section.blocks} />
          {section.links && section.links.length > 0 && (
            <div className="mt-6 border-t border-line pt-4">
              <h2 className="mb-2 text-xs font-medium text-muted">{t('guide.open')}</h2>
              <ul className="flex flex-wrap gap-x-5 gap-y-2">
                {section.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className={LINK}>
                      <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <nav aria-label={t('guide.back')} className="mt-8 flex flex-wrap justify-between gap-3 border-t border-line pt-4">
            {prev ? (
              <Link href={`/guide/${prev.id}`} className={LINK} rel="prev">
                <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
                <span>
                  <span className="sr-only">{t('guide.prev')}: </span>
                  {prev.title}
                </span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link href={`/guide/${next.id}`} className={LINK} rel="next">
                <span>
                  <span className="sr-only">{t('guide.next')}: </span>
                  {next.title}
                </span>
                <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
              </Link>
            )}
          </nav>
        </article>
      </div>
    </>
  );
}
