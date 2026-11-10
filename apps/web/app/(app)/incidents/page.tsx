'use client';

import { Siren } from 'lucide-react';
import { useState } from 'react';
import type { Incident, Paginated } from '@lan-detective/shared-types';
import { IncidentRow } from '@/components/incident-row';
import { Async, Button, Card, EmptyState, PageHeader, Segmented } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';

type Filter = 'active' | 'resolved' | 'all';
const PAGE_SIZE = 25;

export default function IncidentsPage() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const [filter, setFilter] = useState<Filter>('active');
  const [page, setPage] = useState(1);
  const query = useQuery<Paginated<Incident>>(`/incidents${qs({ status: filter, site_id: siteId, page, page_size: PAGE_SIZE })}`, ['events', 'checks', 'collectors']);

  return (
    <>
      <PageHeader
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
      <Card padded={false}>
        <Async query={query}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState icon={<Siren className="size-8" />} title={filter === 'active' ? t('incident.emptyActive') : t('incident.empty')} />
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
