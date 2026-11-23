'use client';

import type { ProgramId } from '@nigafiy/shared-types/programs';
import { ArrowRight } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Card } from '@/components/ui';
import { ProgramGlyph, ProgramLink } from '@/features/platform';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { programById } from '@/lib/programs';

const MOVED: readonly { id: string; label: Key; program: ProgramId; href: string }[] = [
  { id: 'notifications', label: 'settings.notifications', program: 'watch', href: '/watch/notifications' },
  { id: 'maintenance', label: 'platform.nav.maintenance', program: 'watch', href: '/watch/maintenance' },
  { id: 'automation', label: 'platform.nav.automation', program: 'mind', href: '/mind/automation' },
  { id: 'port-control', label: 'platform.nav.portControl', program: 'guard', href: '/guard/port-control' },
  { id: 'sensors', label: 'platform.nav.sensors', program: 'hub', href: '/sensors' },
];

/**
 * Settings → "Moved into the programs": where the settings that used to live on this page are now
 * (Milestone 4). Keeps the old `#automation` (and `#notifications`, `#maintenance`) anchors so a link
 * to them still lands next to the way on.
 */
export function MovedCard() {
  const { t, locale } = useI18n();
  const ref = useRef<HTMLDivElement>(null);

  // The page renders after the session loads, so the browser's own #anchor jump finds nothing; do it here.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash && MOVED.some((m) => m.id === hash)) ref.current?.querySelector(`#${hash}`)?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <div ref={ref}>
      <Card title={t('platform.moved.title')} description={t('platform.moved.intro')}>
        <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
          {MOVED.map((m) => {
            const program = programById(m.program);
            const name = program.name[locale];
            return (
              <li key={m.id} id={m.id} className="flex scroll-mt-20 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 target:bg-accent/10">
                <ProgramGlyph id={m.program} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg">{t(m.label)}</span>
                  <span className="block text-xs text-muted">
                    <bdi>{name}</bdi>
                  </span>
                </span>
                <ProgramLink program={m.program} href={m.href} className="inline-flex items-center gap-1 text-xs font-medium text-accent-hover hover:underline">
                  {fill(t('platform.openIn'), { name })}
                  <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
                </ProgramLink>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
