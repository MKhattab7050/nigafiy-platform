'use client';

import Link from 'next/link';
import type { CheckRole, CheckSeriesPoint, MonitoringCheck, Overview } from '@lan-detective/shared-types';
import { Sparkline, UptimeLegend, UptimeStrip, toCells } from '@/components/charts';
import { Skeleton, StateBadge, Tag } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { ms, pct } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

interface Series {
  from: string;
  to: string;
  bucket_seconds: number;
  points: CheckSeriesPoint[];
}

const ROLES: { role: Exclude<CheckRole, 'service'>; key: 'overview.gateway' | 'overview.internet' | 'overview.dns' }[] = [
  { role: 'gateway', key: 'overview.gateway' },
  { role: 'internet', key: 'overview.internet' },
  { role: 'dns', key: 'overview.dns' },
];

/** 24 h of one check: availability heat row and latency trend (GET /checks/:id/series?range=24h). */
function PathLane({ check, title, summary, showSite }: { check: MonitoringCheck; title: string; summary: Overview['gateway'] | Overview['dns'] | undefined; showSite: boolean }) {
  const { t } = useI18n();
  const series = useQuery<Series>(`/checks/${check.id}/series?range=24h`, ['checks'], 60_000);
  const s = series.data;
  const from = s ? new Date(s.from).getTime() : 0;
  const to = s ? new Date(s.to).getTime() : 0;
  const CELLS = 48;
  const cells = s ? toCells(s.points.map((p) => ({ t: new Date(p.ts).getTime(), samples: p.samples, ok_ratio: p.ok_ratio })), from, to, CELLS) : null;
  // Latency on the same 48 slots as the strip, so the line sits above the time it describes.
  const latency: (number | null)[] = new Array(CELLS).fill(null);
  if (s) {
    const sum = new Array<number>(CELLS).fill(0);
    const n = new Array<number>(CELLS).fill(0);
    for (const p of s.points) {
      const i = Math.floor(((new Date(p.ts).getTime() - from) / (to - from)) * CELLS);
      if (i < 0 || i >= CELLS || p.latency_ms === null) continue;
      const w = Math.max(1, p.samples);
      sum[i]! += p.latency_ms * w;
      n[i]! += w;
    }
    for (let i = 0; i < CELLS; i++) if (n[i]) latency[i] = sum[i]! / n[i]!;
  }
  const loss = summary && 'avg_loss_pct' in summary ? summary.avg_loss_pct : undefined;
  return (
    <div className="min-w-0 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/monitoring" className="text-[13.5px] font-semibold text-fg hover:underline">
          {title}
        </Link>
        <StateBadge state={check.enabled ? check.state : null} />
        {showSite && <Tag>{check.site_name}</Tag>}
      </div>
      <dl className="mt-3 flex gap-6">
        <div>
          <dt className="text-[11.5px] text-muted">{summary ? t('overview.latency') : t('monitoring.latency')}</dt>
          <dd className="tnum mt-0.5 text-lg font-semibold leading-none">{ms(summary?.avg_latency_ms ?? check.last_latency_ms)}</dd>
        </div>
        {loss !== undefined && (
          <div>
            <dt className="text-[11.5px] text-muted">{t('overview.loss')}</dt>
            <dd className={`tnum mt-0.5 text-lg font-semibold leading-none ${loss && loss > 0 ? 'text-warn' : ''}`}>{pct(loss)}</dd>
          </div>
        )}
        <div className="min-w-0 flex-1 self-end">
          {s ? (
            <Sparkline values={latency} label={`${t('dash.latency24h')} · ${title}`} className="h-8 w-full" />
          ) : (
            <Skeleton className="h-8 w-full" />
          )}
        </div>
      </dl>
      <div className="mt-3">
        {cells ? (
          <UptimeStrip cells={cells} label={`${t('dash.availability24h')} · ${title}`} startLabel={t('chart.ago24h')} compact />
        ) : series.error ? (
          <p className="text-xs text-faint">{t('common.error')}</p>
        ) : (
          <Skeleton className="h-4 w-full" />
        )}
      </div>
    </div>
  );
}

/**
 * The network path at a glance — local gateway, internet, DNS — with 24 hours of measured
 * availability and latency. One lane per role, from the first enabled check of that role.
 */
export function NetworkPulse() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const checks = useQuery<{ items: MonitoringCheck[] }>(`/checks${qs({ site_id: siteId })}`, ['checks']);
  const overview = useQuery<Overview>(`/overview${qs({ site_id: siteId })}`, ['events', 'devices', 'checks', 'collectors']);
  if (!checks.data) return null;
  const lanes = ROLES.map((r) => ({ ...r, checks: checks.data!.items.filter((c) => c.role === r.role && c.enabled) }));
  if (lanes.every((l) => l.checks.length === 0)) return null;
  const multiSite = new Set(checks.data.items.map((c) => c.site_id)).size > 1;
  return (
    <section aria-labelledby="pulse-title" className="rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <h2 id="pulse-title" className="text-[13.5px] font-semibold">
          {t('dash.availability24h')}
        </h2>
        <UptimeLegend />
      </header>
      <div className="grid divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0 rtl:md:divide-x-reverse">
        {lanes.map((l) =>
          l.checks[0] ? (
            <PathLane key={l.role} check={l.checks[0]} title={t(l.key)} summary={siteId || !multiSite ? overview.data?.[l.role] : undefined} showSite={multiSite && !siteId} />
          ) : (
            <div key={l.role} className="p-4 sm:p-5">
              <p className="text-[13.5px] font-semibold">{t(l.key)}</p>
              <p className="mt-2 text-xs text-muted">{t('dash.noPathCheck')}</p>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
