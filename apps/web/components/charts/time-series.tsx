'use client';

import dynamic from 'next/dynamic';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ChartTable } from './chart-table';

export interface SeriesDef {
  key: string;
  label: string;
  /** CSS colour (a token var). */
  color: string;
  /**
   * line: the measured value. area: a filled line. faint: secondary line (e.g. per-bucket max).
   * band: 0–100 share on its own hidden scale, drawn as a translucent step (failures, port down).
   * bar: small counts on their own hidden scale (errors).
   */
  kind?: 'line' | 'area' | 'faint' | 'band' | 'bar';
  format?: (v: number) => string;
  /** Leave out of the legend (still in the tooltip and the table). */
  hideLegend?: boolean;
}

export type TimePoint = { t: number } & Record<string, number | null>;

// Recharts is the heaviest client library here: it loads with the first chart on a page, not with
// the page. The table and legend below render at once; the plot area keeps its height while loading.
const TimeSeriesPlot = dynamic(() => import('./time-series-plot').then((m) => m.TimeSeriesPlot), {
  ssr: false,
  loading: () => <span aria-hidden className="block h-full w-full animate-shimmer rounded-[5px] bg-raised/60" />,
});

/** Legend above the plot: a short line in the series colour plus its name (never colour alone). */
export function SeriesLegend({ series }: { series: { key: string; label: string; color: string; dashed?: boolean; swatch?: 'line' | 'block' }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          {s.swatch === 'block' ? (
            <span className="h-2.5 w-2.5 rounded-[2px] opacity-60" style={{ background: s.color }} aria-hidden />
          ) : (
            <span className="h-[3px] w-3.5 rounded-full" style={{ background: s.color }} aria-hidden />
          )}
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Line / area chart over a real time axis. Time always runs left → right (also in Arabic, as on
 * network equipment); ticks and tooltips are in the reader's language. Gaps in the data stay gaps.
 */
export function TimeSeriesChart({
  data,
  from,
  to,
  series,
  yFormat,
  yDomain,
  height = 176,
  withDate,
  label,
  legend = true,
}: {
  data: TimePoint[];
  from: number;
  to: number;
  series: SeriesDef[];
  yFormat: (v: number) => string;
  yDomain?: [number | 'auto', number | 'auto'];
  height?: number;
  withDate?: boolean;
  label: string;
  legend?: boolean;
}) {
  const { t, locale } = useI18n();
  const main = series.filter((s) => s.kind !== 'band' && s.kind !== 'bar');
  const legendItems = series.filter((s) => !s.hideLegend).map((s) => ({ key: s.key, label: s.label, color: s.color, swatch: s.kind === 'band' || s.kind === 'bar' ? ('block' as const) : ('line' as const) }));
  const dense = data.length < 3;
  return (
    <figure className="min-w-0">
      {legend && legendItems.length > 1 && (
        <figcaption className="mb-2">
          <SeriesLegend series={legendItems} />
        </figcaption>
      )}
      <div style={{ height }} dir="ltr" role="img" aria-label={label}>
        <TimeSeriesPlot data={data} from={from} to={to} series={series} yFormat={yFormat} yDomain={yDomain} withDate={withDate} dense={dense} locale={locale} />
      </div>
      <ChartTable
        caption={label}
        columns={[t('chart.time'), ...main.map((s) => s.label), ...series.filter((s) => s.kind === 'band' || s.kind === 'bar').map((s) => s.label)]}
        rows={data.map((p) => [
          absoluteTime(new Date(p.t).toISOString(), locale),
          ...[...main, ...series.filter((s) => s.kind === 'band' || s.kind === 'bar')].map((s) => {
            const v = p[s.key];
            return v === null || v === undefined ? '—' : (s.format ?? yFormat)(v);
          }),
        ])}
      />
    </figure>
  );
}
