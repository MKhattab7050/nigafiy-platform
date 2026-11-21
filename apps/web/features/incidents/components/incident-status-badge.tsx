'use client';

import type { Incident } from '@lan-detective/shared-types';
import { type Key, useI18n } from '@/lib/i18n';
import { Badge, type Tone, severityTone } from '@/components/ui';

export function IncidentStatusBadge({ incident }: { incident: Pick<Incident, 'status' | 'severity'> }) {
  const { t } = useI18n();
  const tone: Tone = incident.status === 'resolved' ? 'ok' : incident.status === 'acknowledged' ? 'info' : severityTone(incident.severity);
  return <Badge tone={tone}>{t(`incident.status.${incident.status}` as Key)}</Badge>;
}
