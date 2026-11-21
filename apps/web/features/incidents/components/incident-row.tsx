'use client';

import clsx from 'clsx';
import Link from 'next/link';
import type { Incident } from '@lan-detective/shared-types';
import { absoluteTime, duration, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';
import { ConfidenceBadge, Tag, ToneIcon, severityTone } from '@/components/ui';
import { IncidentStatusBadge } from './incident-status-badge';

export function IncidentRow({ incident, showSite, compact }: { incident: Incident; showSite: boolean; compact?: boolean }) {
  const { t, locale } = useI18n();
  const tone = severityTone(incident.severity);
  const open = incident.status !== 'resolved';
  return (
    <Link href={`/incidents/${incident.id}`} className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-raised/60">
      <ToneIcon tone={open ? tone : 'idle'} className="mt-0.5 size-4" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="mono text-xs text-faint">INC-{incident.number}</span>
          <span className="min-w-0 text-[13px] font-medium leading-snug text-fg group-hover:text-accent-hover" dir="auto">
            {incident.title}
          </span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="text-fg/80">{t(`severity.${incident.severity}`)}</span>
          <span aria-hidden>·</span>
          <span>{t(`incident.kind.${incident.kind}` as Key)}</span>
          {showSite && incident.site_name && <Tag>{incident.site_name}</Tag>}
          <span title={absoluteTime(incident.opened_at, locale)}>
            {t('incident.opened')} {relativeTime(incident.opened_at, locale)}
          </span>
          <span className="tnum">
            · {duration(incident.opened_at, incident.resolved_at)}
            {incident.resolved_at ? '' : ` (${t('incident.ongoing')})`}
          </span>
          {!compact && (
            <span className="tnum">
              · {incident.event_count} {t('incident.events')}
            </span>
          )}
          {incident.assigned_to_name && <span dir="auto">· {incident.assigned_to_name}</span>}
        </span>
      </span>
      <span className={clsx('flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-2')}>
        {incident.confidence && <ConfidenceBadge confidence={incident.confidence} />}
        <IncidentStatusBadge incident={incident} />
      </span>
    </Link>
  );
}
