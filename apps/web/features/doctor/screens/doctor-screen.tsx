'use client';

import { Stethoscope } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { DoctorReport } from '@lan-detective/shared-types';
import { Async, Badge, Button, Card, EmptyState, ErrorNote, PageHeader } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { DiagnosisView } from '../components/diagnosis-view';
import { domainTone } from '../components/domain-tone';
import { FeatureBoundary } from '@/components/error-boundary';
import { KnowledgeSuggestions } from '@/features/knowledge';

export function DoctorScreen() {
  const { t } = useI18n();
  const { siteId, can } = useApp();
  const query = useQuery<{ items: DoctorReport[] }>(`/doctor${qs({ site_id: siteId })}`, ['checks', 'collectors', 'events'], 20_000);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  async function runChecks(site: string) {
    setBusy(site);
    setError(null);
    setNotice('');
    try {
      await api('/doctor/run-checks', { method: 'POST', body: { site_id: site } });
      setNotice(t('doctor.runQueued'));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <PageHeader icon={<Stethoscope className="size-[18px]" aria-hidden />} title={t('doctor.title')} description={t('doctor.intro')} />
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      {notice && (
        <p role="status" className="mb-3 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-[13px]">
          {notice}
        </p>
      )}
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <Card>
              <EmptyState icon={<Stethoscope className="size-8" />} title={t('doctor.noSites')} />
            </Card>
          ) : (
            <div className="space-y-4">
              {items.map((r) => (
                <Card
                  key={r.site_id}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span dir="auto">{r.site_name}</span>
                      <Badge tone={domainTone(r.diagnosis.fault_domain)}>
                        <span dir="auto">{r.diagnosis.title}</span>
                      </Badge>
                    </span>
                  }
                  action={
                    <span className="flex items-center gap-2">
                      <span className="tnum hidden text-xs text-muted sm:inline">
                        {r.collectors_online} {t('doctor.collectorsOnline')}
                      </span>
                      {r.active_incident && (
                        <Link href={`/incidents/${r.active_incident.id}`} className="text-xs font-medium text-accent-hover hover:underline">
                          {t('doctor.viewIncident')} INC-{r.active_incident.number}
                        </Link>
                      )}
                      {can('technician') && (
                        <Button size="sm" busy={busy === r.site_id} disabled={r.collectors_online === 0} onClick={() => void runChecks(r.site_id)}>
                          {t('doctor.runChecks')}
                        </Button>
                      )}
                    </span>
                  }
                >
                  <DiagnosisView diagnosis={r.diagnosis} />
                  {r.diagnosis.fault_domain !== 'healthy' && !r.active_incident && (
                    <div className="mt-3">
                      <FeatureBoundary>
                        <KnowledgeSuggestions rule={r.diagnosis.rule} siteId={r.site_id} />
                      </FeatureBoundary>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )
        }
      </Async>
    </>
  );
}
