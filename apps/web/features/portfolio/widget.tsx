'use client';

import { Building2 } from 'lucide-react';
import type { PortfolioSites } from '@lan-detective/shared-types';
import { Async } from '@/components/ui';
import { Metric, Widget } from '@/components/widget';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { needsAttention } from './components/kpi-cells';

/** Dashboard: the organization's sites at a glance (GET /portfolio/sites). */
export default function PortfolioWidget() {
  const { t } = useI18n();
  const query = useQuery<PortfolioSites>('/portfolio/sites', ['devices', 'events', 'checks', 'collectors'], 120_000);
  return (
    <Widget title={t('pf.title')} icon={Building2} href="/portfolio">
      <Async query={query}>
        {(r) => {
          const attention = r.items.filter(needsAttention).length;
          const incidents = r.items.reduce((n, s) => n + s.incidents.total, 0);
          return (
            <div className="grid grid-cols-3 gap-2">
              <Metric label={t('pf.widget.sites')} value={r.items.length} href="/portfolio" />
              <Metric label={t('pf.widget.attention')} value={attention} tone={attention ? 'warn' : 'ok'} href="/portfolio" />
              <Metric label={t('pf.widget.incidents')} value={incidents} tone={incidents ? 'warn' : 'idle'} href="/watch/incidents" />
            </div>
          );
        }}
      </Async>
    </Widget>
  );
}
