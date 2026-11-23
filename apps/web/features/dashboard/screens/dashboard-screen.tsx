'use client';

import { Gauge } from 'lucide-react';
import clsx from 'clsx';
import { Suspense } from 'react';
import type { InsightsReport } from '@nigafiy/shared-types';
import { FeatureBoundary } from '@/components/error-boundary';
import { PageHeader, SkeletonBlock } from '@/components/ui';
import { EngineCard, ProgramsStrip } from '@/features/platform';
import { FEATURES } from '@/features/registry';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { AttentionProvider } from '@/lib/attention';
import { usePrograms } from '@/lib/programs-context';
import { useI18n } from '@/lib/i18n';
import { AttentionPanel } from '../components/attention-panel';
import { InsightsPanel } from '../components/insights-panel';
import { NetworkPulse } from '../components/network-pulse';
import { QuickActions } from '../components/quick-actions';
import { StatusHeader } from '../components/status-header';

const SPAN = { wide: 'md:col-span-2', full: 'md:col-span-2 xl:col-span-3' } as const;

/**
 * The one dashboard, read top to bottom as a command centre:
 * status header (score + key counters) → network path, 24 h → programs + engine health (Hub) →
 * what needs attention + advice →
 * every feature's widget → quick actions.
 *
 * It owns no feature data itself: every widget in the grid is registered by its feature in
 * `features/registry.tsx`, each with its own data, loading, empty and error state, inside its
 * own error boundary.
 */
export function DashboardScreen() {
  const { t } = useI18n();
  const { can, siteId } = useApp();
  const { installed } = usePrograms();
  const insights = useQuery<InsightsReport>('/insights' + qs({ site_id: siteId }), ['events', 'devices', 'checks', 'collectors']);
  // Widgets of a program this install does not offer are left out (its data is still collected, spec §6.1).
  const widgets = FEATURES.filter((f) => f.widget && installed(f.program) && (!f.minRole || can(f.minRole)) && (!f.widget.minRole || can(f.widget.minRole))).sort((a, b) => a.widget!.order - b.widget!.order);

  return (
    <AttentionProvider>
      <PageHeader icon={<Gauge className="size-[18px]" aria-hidden />} title={t('nav.dashboard')} description={t('overview.subtitle')} />
      <div className="space-y-5">
        <FeatureBoundary>
          <StatusHeader insights={insights} />
        </FeatureBoundary>
        <FeatureBoundary>
          <NetworkPulse />
        </FeatureBoundary>
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <FeatureBoundary>
            <ProgramsStrip />
          </FeatureBoundary>
          <FeatureBoundary>
            <EngineCard />
          </FeatureBoundary>
        </div>
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <FeatureBoundary>
            <AttentionPanel expected={widgets.filter((f) => f.widget!.attention).map((f) => f.id)} />
          </FeatureBoundary>
          <FeatureBoundary>
            <InsightsPanel insights={insights} />
          </FeatureBoundary>
        </div>
        <section aria-labelledby="widgets-title">
          <h2 id="widgets-title" className="mb-3 text-[13.5px] font-semibold text-fg">
            {t('dash.widgets')}
          </h2>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {widgets.map((f) => {
              const Widget = f.widget!.component;
              return (
                <div key={f.id} className={clsx('min-w-0', f.widget!.span && SPAN[f.widget!.span])}>
                  <FeatureBoundary attentionSource={f.widget!.attention ? f.id : undefined}>
                    <Suspense
                      fallback={
                        <div className="h-full rounded-[var(--radius-card)] border border-line bg-surface p-4">
                          <SkeletonBlock lines={4} />
                        </div>
                      }
                    >
                      <Widget />
                    </Suspense>
                  </FeatureBoundary>
                </div>
              );
            })}
          </div>
        </section>
        <FeatureBoundary>
          <QuickActions />
        </FeatureBoundary>
      </div>
    </AttentionProvider>
  );
}
