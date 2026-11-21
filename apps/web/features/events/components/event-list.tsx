'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { NetworkEvent } from '@lan-detective/shared-types';
import { EVENT_TYPE_LABEL, absoluteTime, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { Badge, Evidence, Tag, severityTone } from '@/components/ui';

/** Timeline of events. Every row expands to the evidence that produced it. */
export function EventList({ events, showSite = true, linkDevice = true }: { events: NetworkEvent[]; showSite?: boolean; linkDevice?: boolean }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-line">
      {events.map((e) => {
        const expanded = open === e.id;
        return (
          <li key={e.id}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : e.id)}
              className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-raised/60"
            >
              <span className="mt-0.5 w-[4.6rem] shrink-0">
                <Badge tone={severityTone(e.severity)} dot={false}>
                  {t(`severity.${e.severity}`)}
                </Badge>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-snug text-fg" dir="auto">
                  {e.title}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                  <span title={absoluteTime(e.occurred_at, locale)}>{relativeTime(e.occurred_at, locale)}</span>
                  <span aria-hidden>·</span>
                  <span>{EVENT_TYPE_LABEL[e.type]?.[locale] ?? e.type}</span>
                  {e.in_maintenance && (
                    <Badge tone="idle" dot={false}>
                      {t('events.inMaintenance')}
                    </Badge>
                  )}
                  {showSite && e.site_name && <Tag>{e.site_name}</Tag>}
                </span>
              </span>
              <ChevronDown className={`mt-1 size-4 shrink-0 text-faint transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
            </button>
            {expanded && (
              <div className="space-y-3 border-t border-line bg-bg/50 px-4 py-3">
                <p className="text-xs font-medium text-muted">{t('events.evidence')}</p>
                <Evidence details={e.details} />
                <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-2 text-xs text-muted">
                  <span>
                    {t('events.occurred')}: <span className="mono">{absoluteTime(e.occurred_at, locale)}</span>
                  </span>
                  <span>
                    {t('events.recorded')}: <span className="mono">{absoluteTime(e.received_at, locale)}</span>
                  </span>
                  <span>{t(e.source === 'collector' ? 'events.source.collector' : 'events.source.platform')}</span>
                  {linkDevice && e.device_id && (
                    <Link href={`/devices/${e.device_id}`} className="font-medium text-accent-hover hover:underline">
                      {t('nav.devices')} →
                    </Link>
                  )}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
