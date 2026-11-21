'use client';

import { Lightbulb } from 'lucide-react';
import type { InsightsReport } from '@lan-detective/shared-types';
import { FeatureBoundary } from '@/components/error-boundary';
import { PageHeader } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { InsightsPanel } from '../components/insights-panel';
import { StatusHeader } from '../components/status-header';

/**
 * Watch, Insights (spec §5): the network score with its deductions and every piece of advice with
 * its evidence and action, the same components and the same GET /insights as the Hub home.
 */
export function InsightsScreen() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const insights = useQuery<InsightsReport>(`/insights${qs({ site_id: siteId })}`, ['events', 'devices', 'checks', 'collectors']);
  return (
    <>
      <PageHeader icon={<Lightbulb className="size-[18px]" aria-hidden />} title={t('platform.nav.insights')} description={t('platform.insights.intro')} />
      <div className="space-y-5">
        <FeatureBoundary>
          <StatusHeader insights={insights} />
        </FeatureBoundary>
        <FeatureBoundary>
          <InsightsPanel insights={insights} expanded />
        </FeatureBoundary>
      </div>
    </>
  );
}
