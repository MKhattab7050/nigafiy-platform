'use client';

import { Siren } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import type { Incident, Paginated } from '@lan-detective/shared-types';
import { AllClearArt } from '@/components/illustrations';
import { Async, Button, Card, EmptyState, Notice, PageHeader, Segmented, SkeletonBlock } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { IncidentRow } from '../components/incident-row';
import { IncidentTrend } from '../components/incident-trend';

export type Filter = 'active' | 'resolved' | 'all';
export const PAGE_SIZE = 25;

export function IncidentsScreen() {
  return (
    <Suspense>
      <IncidentsView />
    </Suspense>
  );
}

function IncidentsView() {
  const { t } = useI18n();
  const { siteId } = useApp();
  // ?device_id= comes from a device card's "Incidents" action: that device's incidents, open or not.
  const deviceId = useSearchParams().get('device_id');
  const [filter, setFilter] = useState<Filter>(deviceId ? 'all' : 'active');
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [siteId]);
  const query = useQuery<Paginated<Incident>>(`/incidents${qs({ status: filter, site_id: siteId, device_id: deviceId, page, page_size: PAGE_SIZE })}`, ['events', 'checks', 'collectors']);

  return (
    <>
      <PageHeader
        icon={<Siren className="size-[18px]" />}
        title={t('incident.title')}
        description={t('incident.intro')}
        actions={
          <Segmented
            label={t('incident.title')}
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setPage(1);
            }}
            options={(['active', 'resolved', 'all'] as const).map((f) => ({ value: f, label: t(`incident.filter.${f}`) }))}
          />
        }
      />
      {deviceId && (
        <Notice className="mb-4">
          {t('platform.incidents.forDevice')}{' '}
          <Link href="/watch/incidents" className="font-medium text-accent-hover hover:underline">
            {t('platform.incidents.allDevices')}
          </Link>
        </Notice>
      )}
      <IncidentTrend days={30} height={110} framed />
      <Card padded={false}>
        <Async query={query} skeleton={<div className="p-4"><SkeletonBlock lines={5} /></div>}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState illustration={<AllClearArt />} title={filter === 'active' ? t('incident.emptyActive') : t('incident.empty')} />
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {data.items.map((i) => (
                    <li key={i.id}>
                      <IncidentRow incident={i} showSite={!siteId} />
                    </li>
                  ))}
                </ul>
                {data.total > PAGE_SIZE && (
                  <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-muted">
                    <span className="tnum">
                      {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} / {data.total}
                    </span>
                    <span className="flex gap-2">
                      <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                        {t('devices.prev')}
                      </Button>
                      <Button size="sm" disabled={page * PAGE_SIZE >= data.total} onClick={() => setPage(page + 1)}>
                        {t('devices.next')}
                      </Button>
                    </span>
                  </div>
                )}
              </>
            )
          }
        </Async>
      </Card>
    </>
  );
}
