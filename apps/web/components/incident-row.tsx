'use client';

import Link from 'next/link';
import type { Incident } from '@lan-detective/shared-types';
import { absoluteTime, duration, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';
import { ConfidenceBadge, IncidentStatusBadge } from './diagnosis';
import { Badge, Tag, severityTone } from './ui';

export function IncidentRow({ incident, showSite }: { incident: Incident; showSite: boolean }) {
  const { t, locale } = useI18n();
  return (
    <Link href={`/incidents/${incident.id}`} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 hover:bg-raised/60">
      <span className="mono mt-0.5 w-16 shrink-0 text-xs text-muted">INC-{incident.number}</span>
      <span className="min-w-0 flex-1 basis-64">
        <span className="block text-[13px] font-medium leading-snug text-fg" dir="auto">
          {incident.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span>{t(`incident.kind.${incident.kind}` as Key)}</span>
          {showSite && incident.site_name && <Tag>{incident.site_name}</Tag>}
          <span title={absoluteTime(incident.opened_at, locale)}>
            {t('incident.opened')} {relativeTime(incident.opened_at, locale)}
          </span>
          <span className="tnum">
            · {duration(incident.opened_at, incident.resolved_at)}
            {incident.resolved_at ? '' : ` (${t('incident.ongoing')})`}
          </span>
          <span className="tnum">
            · {incident.event_count} {t('incident.events')}
          </span>
          {incident.assigned_to_name && <span dir="auto">· {incident.assigned_to_name}</span>}
        </span>
      </span>
      <span className="flex shrink-0 flex-wrap items-center gap-2">
        {incident.confidence && <ConfidenceBadge confidence={incident.confidence} />}
        <Badge tone={severityTone(incident.severity)} dot={false}>
          {t(`severity.${incident.severity}`)}
        </Badge>
        <IncidentStatusBadge incident={incident} />
      </span>
    </Link>
  );
}
