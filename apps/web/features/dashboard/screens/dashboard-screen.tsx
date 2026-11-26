'use client';

import { Gauge } from 'lucide-react';
import clsx from 'clsx';
import { Suspense } from 'react';
import type { DashboardGuidance, InsightsReport } from '@nigafiy/shared-types';
import { FeatureBoundary } from '@/components/error-boundary';
import { PageHeader, SkeletonBlock } from '@/components/ui';
import { EngineCard, ProgramsStrip } from '@/features/platform';
import { FEATURES } from '@/features/registry';
import { qs } from '@/lib/api';
import { type Query, useApp, useQuery } from '@/lib/app';
import { AttentionProvider } from '@/lib/attention';
import { usePrograms } from '@/lib/programs-context';
import { useView } from '@/lib/view';
import { dashboardWidgets } from '@/lib/view-mode';
import { useI18n } from '@/lib/i18n';
import { AttentionPanel } from '../components/attention-panel';
import { ConnectNetworkCard, needsNetworkSetup } from '../components/connect-network-card';
import { InsightsPanel } from '../components/insights-panel';
import { NetworkPulse } from '../components/network-pulse';
import { NextSteps } from '../components/next-steps';
import { SetupChecklist, useChecklistVisible } from '../components/setup-checklist';
import { QuickActions } from '../components/quick-actions';
import { StatusHeader } from '../components/status-header';
import { QuickNameCard } from '@/features/devices/components/quick-name-card';

const SKIP_REVIEW: ReadonlySet<string> = new Set(['unreviewed']);

const SPAN = { wide: 'md:col-span-2', full: 'md:col-span-2 xl:col-span-3' } as const;

/**
 * The one dashboard, read top to bottom as a command centre:
 * status header (score + key counters) → "Next" (1–3 steps) and the getting-started checklist →
 * network path, 24 h → programs + engine health (Hub) →
 * what needs attention + advice →
 * every feature's widget → quick actions.
 *
 * It owns no feature data itself: every widget in the grid is registered by its feature in
 * `features/registry.tsx`, each with its own data, loading, empty and error state, inside its
 * own error boundary.
 *
 * Before a network is connected (insights carry the "setup" deduction) every counter would read 0,
 * so the page shows one "Connect your network" card instead. While insights load, the full
 * dashboard renders with its usual skeletons. A card that belongs in both states goes in the
 * `space-y-5` stack below, beside the branch.
 */
export function DashboardScreen() {
  const { t } = useI18n();
  const { can, siteId } = useApp();
  const { installed } = usePrograms();
  const { view } = useView();
  const insights = useQuery<InsightsReport>('/insights' + qs({ site_id: siteId }), ['events', 'devices', 'checks', 'collectors']);
  // Widgets of a program this install does not offer are left out (its data is still collected, spec §6.1).
  // The simple (Home) view keeps the widgets flagged `home` (lib/view-mode.ts); the others stay one switch away.
  const widgets = dashboardWidgets(FEATURES, view).filter((f) => installed(f.program) && (!f.minRole || can(f.minRole)) && (!f.widget!.minRole || can(f.widget!.minRole))).sort((a, b) => a.widget!.order - b.widget!.order);

  return (
    <AttentionProvider>
      <PageHeader icon={<Gauge className="size-[18px]" aria-hidden />} title={t('nav.dashboard')} description={t('overview.subtitle')} />
      <div className="space-y-5">
        {needsNetworkSetup(insights.data) ? (
          <FeatureBoundary>
            <ConnectNetworkCard />
          </FeatureBoundary>
        ) : (
          <ConnectedDashboard insights={insights} widgets={widgets} simple={view === 'home'} />
        )}
      </div>
    </AttentionProvider>
  );
}

/** The dashboard as it reads once a network is connected. */
function ConnectedDashboard({ insights, widgets, simple }: { insights: Query<InsightsReport>; widgets: typeof FEATURES; simple: boolean }) {
  const { t } = useI18n();
  const { siteId } = useApp();
  const guidance = useQuery<DashboardGuidance>(`/dashboard/guidance${qs({ site_id: siteId })}`, ['events', 'devices', 'collectors'], 60_000);
  // While the checklist asks to review devices, "Next" does not ask for it a second time.
  const checklist = useChecklistVisible(guidance);
  const reviewOpen = checklist && guidance.data?.steps.some((s) => s.key === 'reviewed' && !s.done);
  return (
    <>
      <FeatureBoundary>
        <StatusHeader insights={insights} guidance={guidance} />
      </FeatureBoundary>
      <FeatureBoundary>
        <NextSteps insights={insights} skip={reviewOpen ? SKIP_REVIEW : undefined} />
      </FeatureBoundary>
      <FeatureBoundary>
        <SetupChecklist guidance={guidance} />
      </FeatureBoundary>
      {/* Hidden when every device has a name (or the user may not rename). */}
      <FeatureBoundary>
        <QuickNameCard />
      </FeatureBoundary>
      <FeatureBoundary>
        <NetworkPulse />
      </FeatureBoundary>
      {/* The simple view leaves the program strip out; the engine card says whether monitoring runs. */}
      <div className={clsx('grid grid-cols-1 gap-5', !simple && 'xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
        {!simple && (
          <FeatureBoundary>
            <ProgramsStrip />
          </FeatureBoundary>
        )}
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
    </>
  );
}
