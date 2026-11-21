'use client';

import type { CheckSeriesPoint, MonitoringCheck } from '@lan-detective/shared-types';
import { TimeSeriesChart, UptimeStrip, toCells } from '@/components/charts';
import { Async, SkeletonBlock } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { ms, pct } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export const RANGES = ['15m', '1h', '24h', '7d', '30d', '90d'] as const;
export type Range = (typeof RANGES)[number];
export interface Series {
  from: string;
  to: string;
  bucket_seconds: number;
  points: CheckSeriesPoint[];
}

/**
 * One check over the chosen range (GET /checks/:id/series): availability heat row, then latency
 * (average and per-bucket maximum) with failed samples drawn as a red band behind the line.
 */
export function CheckChart({ check, range }: { check: MonitoringCheck; range: Range }) {
  const { t } = useI18n();
  const query = useQuery<Series>(`/checks/${check.id}/series?range=${range}`, [], 30_000);
  const withDate = range === '7d' || range === '30d' || range === '90d';
  return (
    <Async query={query} skeleton={<SkeletonBlock chart lines={1} />}>
      {(series) => {
        if (!series.points.length) return <p className="py-8 text-center text-xs leading-relaxed text-faint">{t('monitoring.noSamples')}</p>;
        const from = new Date(series.from).getTime();
        const to = new Date(series.to).getTime();
        const total = series.points.reduce((n, p) => n + p.samples, 0);
        const okSamples = series.points.reduce((n, p) => n + p.samples * p.ok_ratio, 0);
        const data = series.points.map((p) => ({
          t: new Date(p.ts).getTime(),
          latency_ms: p.latency_ms,
          latency_max_ms: p.latency_max_ms,
          fail: p.ok_ratio < 1 ? (1 - p.ok_ratio) * 100 : null,
        }));
        const cells = toCells(
          series.points.map((p) => ({ t: new Date(p.ts).getTime(), samples: p.samples, ok_ratio: p.ok_ratio })),
          from,
          to,
          Math.min(60, Math.max(12, Math.round((to - from) / 1000 / series.bucket_seconds))),
        );
        return (
          <div className="space-y-4">
            <UptimeStrip cells={cells} label={`${t('monitoring.success')} · ${check.name}`} startLabel={`−${range}`} compact />
            <TimeSeriesChart
              data={data}
              from={from}
              to={to}
              withDate={withDate}
              label={`${t('monitoring.latency')} · ${check.name}`}
              yFormat={(v) => ms(v)}
              series={[
                { key: 'latency_ms', label: t('monitoring.latency'), color: 'var(--color-series-1)', kind: 'area' },
                { key: 'latency_max_ms', label: t('monitoring.latencyMax'), color: 'var(--color-series-1)', kind: 'faint' },
                { key: 'fail', label: t('chart.failedShare'), color: 'var(--color-crit)', kind: 'band', format: (v) => pct(v) },
              ]}
            />
            <p className="tnum text-[11.5px] text-faint">
              {t('monitoring.success')}: <span className="font-medium text-muted">{pct((okSamples / total) * 100, 2)}</span> · {total} {t('overview.samples')}
            </p>
          </div>
        );
      }}
    </Async>
  );
}
