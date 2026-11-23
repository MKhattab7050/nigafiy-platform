'use client';

import { Siren } from 'lucide-react';
import type { Incident, Paginated } from '@nigafiy/shared-types';
import { AllClearArt } from '@/components/illustrations';
import { Async, SkeletonBlock } from '@/components/ui';
import { NextStep, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useReportAttention } from '@/lib/attention';
import { fill, useI18n } from '@/lib/i18n';
import { IncidentRow } from './components/incident-row';
import { IncidentTrend } from './components/incident-trend';

const SHOWN = 4;

/**
 * Dashboard: the incidents that are still open, most serious first (GET /incidents?status=active),
 * and how many were opened per day over the last two weeks (GET /incidents?status=all).
 */
export default function IncidentsWidget() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const query = useQuery<Paginated<Incident>>(`/incidents${qs({ status: 'active', site_id: siteId, page_size: SHOWN })}`, ['events', 'checks', 'collectors']);

  useReportAttention(
    'incidents',
    attentionFrom([query], (page) => {
      const top = page.items[0];
      if (!top) return [];
      const single = page.total === 1;
      return [
        {
          id: 'incidents-open',
          tone: top.severity === 'critical' ? 'crit' : 'warn',
          text: single ? fill(t('incident.attn.one'), { number: top.number, title: top.title }) : fill(t('incident.attn.many'), { count: page.total, title: top.title }),
          action: single ? { label: t('incident.attn.openOne'), href: `/watch/incidents/${top.id}` } : { label: t('incident.attn.openAll'), href: '/watch/incidents' },
        },
      ];
    }),
  );

  return (
    <Widget title={t('overview.activeIncidents')} icon={Siren} href="/watch/incidents" padded={false}>
      <Async query={query} skeleton={<div className="p-4"><SkeletonBlock lines={4} /></div>}>
        {(page) => (
          <div className="grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="min-w-0">
              {page.items.length === 0 ? (
                <div className="p-4">
                  <NextStep art={<AllClearArt className="h-14 w-28" />} text={t('incident.emptyActive')} />
                </div>
              ) : (
                <>
                  <ul className="divide-y divide-line border-t border-line">
                    {page.items.map((i) => (
                      <li key={i.id}>
                        <IncidentRow incident={i} showSite={!siteId} compact />
                      </li>
                    ))}
                  </ul>
                  {page.total > page.items.length && <p className="tnum border-t border-line px-4 py-2 text-xs text-muted">{fill(t('incident.widget.more'), { count: page.total - page.items.length })}</p>}
                </>
              )}
            </div>
            <div className="min-w-0 border-t border-line p-4 lg:border-s">
              <IncidentTrend />
            </div>
          </div>
        )}
      </Async>
    </Widget>
  );
}
