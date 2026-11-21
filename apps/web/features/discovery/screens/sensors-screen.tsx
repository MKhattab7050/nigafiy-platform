'use client';

import { ArrowRight, RadioTower } from 'lucide-react';
import { useState } from 'react';
import type { Collector, CollectorCreated } from '@lan-detective/shared-types';
import { Async, Card, EmptyState, PageHeader } from '@/components/ui';
import { ProgramLink } from '@/features/platform';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { SiteSensors } from '../components/site-sensors';
import { TokenModal } from '../components/token-modal';

/**
 * Hub, Sensors: every site's network collectors in one place (spec §5: Sensor management is Hub's).
 * Adding a Sensor issues its one-time enrollment token; pending tokens can be re-issued; a Sensor can
 * be revoked. Same API and permission checks as before (admin writes, technician scans, viewer reads).
 */
export function SensorsScreen() {
  const { t } = useI18n();
  const { sites, siteId, reloadSites } = useApp();
  const collectors = useQuery<{ items: Collector[] }>('/collectors', ['collectors'], 15_000);
  const [token, setToken] = useState<CollectorCreated | null>(null);
  const visible = sites.filter((s) => !siteId || s.id === siteId);
  const reload = () => {
    collectors.reload();
    reloadSites();
  };

  return (
    <>
      <PageHeader icon={<RadioTower className="size-[18px]" aria-hidden />} title={t('platform.sensors.title')} description={t('platform.sensors.intro')} />
      <Async query={collectors}>
        {(co) =>
          visible.length === 0 ? (
            <Card>
              <EmptyState icon={<RadioTower className="size-8" />} title={t('platform.sensors.noSites')}>
                <ProgramLink program="radar" href="/radar/discovery" className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-accent-hover hover:underline">
                  {t('platform.sensors.toDiscovery')}
                  <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
                </ProgramLink>
              </EmptyState>
            </Card>
          ) : (
            <div className="space-y-4">
              {visible.map((site) => (
                <Card key={site.id} title={<span dir="auto">{site.name}</span>}>
                  <SiteSensors site={site} collectors={co.items.filter((c) => c.site_id === site.id)} reload={reload} onToken={setToken} manage />
                </Card>
              ))}
            </div>
          )
        }
      </Async>
      {token && <TokenModal created={token} onClose={() => setToken(null)} />}
    </>
  );
}
