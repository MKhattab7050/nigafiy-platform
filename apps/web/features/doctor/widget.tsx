'use client';

import { Stethoscope } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { DoctorReport } from '@lan-detective/shared-types';
import { Async, Badge, Button, ErrorNote } from '@/components/ui';
import { NextStep, Widget } from '@/components/widget';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { domainTone } from './components/domain-tone';

/** Dashboard: Network Doctor's live verdict per site, with the same "Run checks now" as the Doctor page (GET /doctor). */
export default function DoctorWidget() {
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
    <Widget title={t('overview.faultDomain')} icon={Stethoscope} href="/doctor">
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <NextStep text={t('doctor.noSites')} label={t('overview.setupCta')} href="/discovery" />
          ) : (
            <div className="space-y-3">
              {error && <ErrorNote error={error} />}
              {notice && (
                <p role="status" className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs">
                  {notice}
                </p>
              )}
              <ul className="space-y-3">
                {items.map((r) => (
                  <li key={r.site_id} className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {items.length > 1 && (
                        <span className="text-[13px] font-medium" dir="auto">
                          {r.site_name}
                        </span>
                      )}
                      <Badge tone={domainTone(r.diagnosis.fault_domain)}>
                        <span dir="auto">{r.diagnosis.title}</span>
                      </Badge>
                    </div>
                    <p className="text-[13px] leading-relaxed text-muted" dir="auto">
                      {r.diagnosis.summary}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {can('technician') && (
                        <Button size="sm" busy={busy === r.site_id} disabled={r.collectors_online === 0} onClick={() => void runChecks(r.site_id)}>
                          {t('doctor.runChecks')}
                        </Button>
                      )}
                      {r.active_incident && (
                        <Link href={`/incidents/${r.active_incident.id}`} className="text-xs font-medium text-accent-hover hover:underline">
                          {t('doctor.viewIncident')} INC-{r.active_incident.number}
                        </Link>
                      )}
                      <span className="tnum text-[11px] text-faint">
                        {r.collectors_online} {t('doctor.collectorsOnline')}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )
        }
      </Async>
    </Widget>
  );
}
