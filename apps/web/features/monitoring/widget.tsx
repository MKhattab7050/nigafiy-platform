'use client';

import { Activity } from 'lucide-react';
import Link from 'next/link';
import type { MonitoringCheck, Overview } from '@lan-detective/shared-types';
import { ProportionBar } from '@/components/charts';
import { Async, StateBadge } from '@/components/ui';
import { Metric, NextStep, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useReportAttention } from '@/lib/attention';
import { ms, pct } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';

const RANK = { down: 0, degraded: 1, unknown: 2, ok: 3 } as const;

/**
 * Dashboard: are the checks healthy? Counts and 24 h availability come from GET /overview; the
 * names, states and last latency of the checks from GET /checks. (The gateway / internet / DNS
 * lanes with 24 h history sit at the top of the dashboard.)
 */
export default function MonitoringWidget() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const overview = useQuery<Overview>(`/overview${qs({ site_id: siteId })}`, ['events', 'devices', 'checks', 'collectors']);
  const checks = useQuery<{ items: MonitoringCheck[] }>(`/checks${qs({ site_id: siteId })}`, ['checks']);

  useReportAttention(
    'monitoring',
    attentionFrom([checks], ({ items }) => {
      const failing = items.filter((c) => c.enabled && (c.state === 'down' || c.state === 'degraded'));
      return failing.slice(0, 4).map((c) => ({
        id: `check-${c.id}`,
        tone: c.state === 'down' ? ('crit' as const) : ('warn' as const),
        text: fill(t(c.state === 'down' ? 'monitoring.attn.down' : 'monitoring.attn.degraded'), { name: c.name }),
        action: { label: t('monitoring.attn.action'), href: '/watch/monitoring' },
      }));
    }),
  );

  return (
    <Widget title={t('nav.monitoring')} icon={Activity} href="/watch/monitoring">
      <Async query={overview}>
        {(o) => {
          if (o.checks.total === 0) return <NextStep text={t('monitoring.widget.empty')} label={t('monitoring.addCheck')} href="/watch/monitoring" />;
          const a = o.availability_24h_pct;
          const list = (checks.data?.items ?? []).filter((c) => c.enabled).sort((x, y) => RANK[x.state] - RANK[y.state]);
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric size="lg" label={t('overview.availability')} value={a === null ? '—' : pct(a, 2)} tone={a === null ? 'idle' : a >= 99.5 ? 'ok' : a >= 95 ? 'warn' : 'crit'} />
                <Metric label={t('state.ok')} value={o.checks.ok} tone="ok" href="/watch/monitoring" />
                <Metric label={t('state.degraded')} value={o.checks.degraded} tone={o.checks.degraded ? 'warn' : 'idle'} href="/watch/monitoring" />
                <Metric label={t('state.down')} value={o.checks.down} tone={o.checks.down ? 'crit' : 'idle'} href="/watch/monitoring" />
              </div>
              <ProportionBar
                label={t('nav.monitoring')}
                slices={[
                  { key: 'ok', label: t('state.ok'), value: o.checks.ok, color: 'var(--color-ok)' },
                  { key: 'degraded', label: t('state.degraded'), value: o.checks.degraded, color: 'var(--color-warn)' },
                  { key: 'down', label: t('state.down'), value: o.checks.down, color: 'var(--color-crit)' },
                  { key: 'unknown', label: t('state.unknown'), value: o.checks.unknown, color: 'var(--color-idle)' },
                ]}
              />
              {list.length > 0 && (
                <div>
                  <ul className="divide-y divide-line rounded-[8px] border border-line">
                    {list.slice(0, 5).map((c) => (
                      <li key={c.id}>
                        <Link href="/watch/monitoring" className="flex items-center gap-3 px-3 py-2 hover:bg-raised/60">
                          <span className="min-w-0 flex-1 truncate text-[13px]" dir="auto">
                            {c.name}
                          </span>
                          <span className="tnum text-xs text-muted">{ms(c.last_latency_ms)}</span>
                          <StateBadge state={c.state} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-faint">
                <span>{t('overview.availabilityHint')}</span>
                <span className={`tnum font-medium ${o.open_problems > 0 ? 'text-crit' : 'text-ok'}`} title={t('overview.openProblemsHint')}>
                  {t('overview.openProblems')}: {o.open_problems}
                </span>
              </p>
            </div>
          );
        }}
      </Async>
    </Widget>
  );
}
