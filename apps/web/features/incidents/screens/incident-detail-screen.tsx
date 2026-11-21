'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { IncidentDetail } from '@lan-detective/shared-types';
import { Async, Badge, Card, Fact, PageHeader, severityTone } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { absoluteTime, duration, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';
import { DiagnosisView } from '@/features/doctor';
import { FeatureBoundary } from '@/components/error-boundary';
import { ExplainWithAi } from '@/features/assistant';
import { KnowledgeSuggestions } from '@/features/knowledge';
import { Replay } from '../components/incident-replay';
import { Actions } from '../components/incident-actions';
import { IncidentStatusBadge } from '../components/incident-status-badge';

export function IncidentDetailScreen({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const query = useQuery<IncidentDetail>(`/incidents/${id}`, ['events', 'checks', 'collectors', 'devices']);

  return (
    <>
      <Link href="/incidents" className="mb-4 inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted hover:text-fg">
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {t('incident.back')}
      </Link>
      <Async query={query}>
        {(inc) => (
          <>
            <PageHeader
              title={inc.title}
              description={`INC-${inc.number} · ${t(`incident.kind.${inc.kind}` as Key)}${inc.site_name ? ` · ${inc.site_name}` : ''}`}
              actions={
                <>
                  <Badge tone={severityTone(inc.severity)} dot={false}>
                    {t(`severity.${inc.severity}`)}
                  </Badge>
                  <IncidentStatusBadge incident={inc} />
                </>
              }
            />
            <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
              <div className="space-y-4">
                <Card title={t('dx.title')}>
                  {inc.diagnosis ? <DiagnosisView diagnosis={inc.diagnosis} /> : <p className="text-[13px] text-muted">{t('dx.none')}</p>}
                  {inc.diagnosis && (
                    <FeatureBoundary>
                      <ExplainWithAi subject="incident" incidentId={inc.id} />
                    </FeatureBoundary>
                  )}
                </Card>
                <FeatureBoundary>
                  <KnowledgeSuggestions incidentId={inc.id} />
                </FeatureBoundary>
                <Card title={t('incident.replay')} padded={false}>
                  <p className="border-b border-line px-4 py-2.5 text-xs leading-relaxed text-muted">{t('incident.replayHint')}</p>
                  <Replay incident={inc} />
                </Card>
              </div>
              <div className="space-y-4">
                <Card>
                  <dl>
                    <Fact label={t('incident.opened')}>
                      {absoluteTime(inc.opened_at, locale)} <span className="text-muted">· {relativeTime(inc.opened_at, locale)}</span>
                    </Fact>
                    <Fact label={t('incident.duration')}>
                      <span className="tnum">{duration(inc.opened_at, inc.resolved_at)}</span>
                      {!inc.resolved_at && <span className="text-muted"> · {t('incident.ongoing')}</span>}
                    </Fact>
                    {inc.diagnosis && (
                      <Fact label={t('dx.affected')}>
                        <span className="tnum">
                          {inc.diagnosis.affected.devices_offline}/{inc.diagnosis.affected.devices_total} {t('dx.devicesOffline')}
                        </span>
                        {inc.diagnosis.affected.checks.map((c) => (
                          <span key={c.id} className="block text-xs text-muted" dir="auto">
                            {c.name} — {t(`state.${c.state}` as Key)}
                          </span>
                        ))}
                      </Fact>
                    )}
                    {inc.resolved_at && (
                      <Fact label={t('incident.resolution')} source={t(inc.resolution_kind === 'manual' ? 'incident.resolution.manual' : 'incident.resolution.auto')}>
                        <span dir="auto">{inc.resolution_note ?? '—'}</span>
                        <span className="block text-xs text-muted">{absoluteTime(inc.resolved_at, locale)}</span>
                      </Fact>
                    )}
                    {inc.device_id && (
                      <Fact label={t('nav.devices')}>
                        <Link href={`/devices/${inc.device_id}`} className="text-accent-hover hover:underline">
                          {t('topo.openDevice')} →
                        </Link>
                      </Fact>
                    )}
                  </dl>
                </Card>
                <Card title={t('device.manage')}>
                  <Actions incident={inc} reload={query.reload} />
                </Card>
                <Card title={t('incident.activity')} padded={false}>
                  <ul className="divide-y divide-line">
                    {inc.activity.map((a) => (
                      <li key={a.id} className="px-4 py-2.5">
                        <p className={`text-[13px] leading-relaxed ${a.kind === 'comment' ? 'text-fg' : 'text-muted'}`} dir="auto">
                          {a.body}
                        </p>
                        <p className="mt-0.5 text-[11px] text-faint">
                          {a.user_name ?? 'LAN Detective'} · <span title={absoluteTime(a.created_at, locale)}>{relativeTime(a.created_at, locale)}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
