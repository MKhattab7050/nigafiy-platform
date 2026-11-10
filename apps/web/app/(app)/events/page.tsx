'use client';

import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { NetworkEvent } from '@lan-detective/shared-types';
import { EventList } from '@/components/event-list';
import { Async, Button, Card, EmptyState, PageHeader, Segmented, Select } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { EVENT_TYPE_LABEL } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

interface Page {
  items: NetworkEvent[];
  next_before: string | null;
}
const WINDOWS = { '15m': 900, '1h': 3600, '24h': 86_400, '7d': 604_800, '30d': 2_592_000, all: 0 } as const;
type Window = keyof typeof WINDOWS;

export default function EventsPage() {
  const { t, locale } = useI18n();
  const { siteId } = useApp();
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');
  const [window, setWindow] = useState<Window>('24h');
  const [older, setOlder] = useState<NetworkEvent[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  // Rounded to the minute so the query key is stable between renders.
  const from = WINDOWS[window] ? new Date(Math.floor(Date.now() / 60_000) * 60_000 - WINDOWS[window] * 1000).toISOString() : '';
  const filter = { site_id: siteId, severity, type, from };
  const query = useQuery<Page>(`/events${qs({ ...filter, limit: 50 })}`, ['events']);

  useEffect(() => {
    setOlder([]);
    setCursor(undefined);
  }, [siteId, severity, type, window]);

  const nextBefore = cursor === undefined ? query.data?.next_before : cursor;
  async function loadMore() {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const page = await api<Page>(`/events${qs({ ...filter, limit: 50, before: nextBefore })}`);
      setOlder((prev) => [...prev, ...page.items]);
      setCursor(page.next_before);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t('events.title')}
        actions={<Segmented label={t('monitoring.range')} value={window} onChange={setWindow} options={(Object.keys(WINDOWS) as Window[]).map((w) => ({ value: w, label: w === 'all' ? t('common.all') : w }))} />}
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label={t('events.severity')} value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-44">
          <option value="">
            {t('events.severity')}: {t('common.all')}
          </option>
          {(['critical', 'warning', 'info'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`severity.${s}`)}
            </option>
          ))}
        </Select>
        <Select aria-label={t('events.type')} value={type} onChange={(e) => setType(e.target.value)} className="w-56">
          <option value="">
            {t('events.type')}: {t('common.all')}
          </option>
          {Object.entries(EVENT_TYPE_LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label[locale]}
            </option>
          ))}
        </Select>
      </div>
      <Card padded={false}>
        <Async query={query}>
          {(data) => {
            const seen = new Set(data.items.map((e) => e.id));
            const all = [...data.items, ...older.filter((e) => !seen.has(e.id))];
            if (!all.length) return <EmptyState icon={<History className="size-8" />} title={t('events.empty')} />;
            return (
              <>
                <EventList events={all} showSite={!siteId} />
                {nextBefore && (
                  <div className="border-t border-line p-3 text-center">
                    <Button size="sm" busy={loadingMore} onClick={() => void loadMore()}>
                      {t('common.loadMore')}
                    </Button>
                  </div>
                )}
              </>
            );
          }}
        </Async>
      </Card>
    </>
  );
}
