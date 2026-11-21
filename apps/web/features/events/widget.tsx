'use client';

import { ScrollText } from 'lucide-react';
import type { NetworkEvent } from '@lan-detective/shared-types';
import { Async } from '@/components/ui';
import { NextStep, Widget } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { EventList } from './components/event-list';

/** Dashboard: the latest events for the selected site (GET /events, limit 6). */
export default function EventsWidget() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const query = useQuery<{ items: NetworkEvent[] }>(`/events${qs({ site_id: siteId, limit: 6 })}`, ['events']);

  return (
    <Widget title={t('overview.recentEvents')} icon={ScrollText} href="/watch/events" padded={false}>
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <div className="p-4">
              <NextStep text={t('events.widget.none')} label={t('overview.setupCta')} href="/radar/discovery" />
            </div>
          ) : (
            <EventList events={items} showSite={!siteId} />
          )
        }
      </Async>
    </Widget>
  );
}
