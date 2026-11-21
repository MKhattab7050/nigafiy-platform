'use client';

import { useState } from 'react';
import type { IncidentDetail } from '@lan-detective/shared-types';
import { Badge, EmptyState, Evidence, Tag, severityTone } from '@/components/ui';
import { EVENT_TYPE_LABEL, absoluteTime, clockTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';

export const PHASE_STYLE = { before: 'border-line-strong', during: 'border-crit/60', after: 'border-ok/60' } as const;

/** Before / during / after, in chronological order — what led up to the incident and what followed. */
export function Replay({ incident }: { incident: IncidentDetail }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (!incident.timeline.length) return <EmptyState title={t('incident.noTimeline')} />;
  let lastPhase = '';
  return (
    <ol className="px-4 py-3">
      {incident.timeline.map((e) => {
        const heading = e.phase !== lastPhase;
        lastPhase = e.phase;
        return (
          <li key={e.id}>
            {heading && <p className="mb-1 mt-3 text-xs font-semibold text-muted first:mt-0">{t(`incident.phase.${e.phase}` as Key)}</p>}
            <div className={`border-s-2 ps-3 ${PHASE_STYLE[e.phase]}`}>
              <button type="button" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full items-start gap-3 rounded py-1.5 text-start hover:bg-raised/60">
                <span className="mono w-28 shrink-0 pt-0.5 text-xs text-muted" title={absoluteTime(e.occurred_at, locale)}>
                  {clockTime(e.occurred_at, locale, true)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] leading-snug ${e.linked ? 'font-medium text-fg' : 'text-muted'}`} dir="auto">
                    {e.title}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-faint">
                    {EVENT_TYPE_LABEL[e.type]?.[locale] ?? e.type}
                    {e.linked && <Tag>{t('incident.linked')}</Tag>}
                  </span>
                </span>
                <Badge tone={severityTone(e.severity)} dot={false}>
                  {t(`severity.${e.severity}`)}
                </Badge>
              </button>
              {open === e.id && (
                <div className="mb-2 rounded-md border border-line bg-bg/60 p-3">
                  <Evidence details={e.details} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
