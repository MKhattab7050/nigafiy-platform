'use client';

import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { absoluteTime, clockTime } from '@/lib/format';
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

const AXIS_TICK = { fill: 'var(--color-faint)', fontSize: 11 };

function ChartTooltip({
  active,
  payload,
  label,
  series,
  locale,
  yFormat,
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | null }[];
  label?: number | string;
  series: SeriesDef[];
  locale: 'en' | 'ar';
  yFormat: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const rows = series
    .map((s) => ({ s, v: payload.find((p) => p.dataKey === s.key)?.value }))
    .filter((r) => r.v !== null && r.v !== undefined && !(r.s.kind === 'band' && r.v === 0));
  return (
    <div className="min-w-40 rounded-[8px] border border-line-strong bg-surface px-3 py-2 text-xs shadow-[var(--shadow-overlay)]" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <p className="tnum mb-1.5 text-faint">{absoluteTime(new Date(Number(label)).toISOString(), locale)}</p>
      {rows.length === 0 ? (
        <p className="text-muted">—</p>
      ) : (
        <ul className="space-y-1">
          {rows.map(({ s, v }) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
              <span className="flex-1 text-muted">{s.label}</span>
              <span className="tnum font-medium text-fg">{(s.format ?? yFormat)(Number(v))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-line)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[from, to]}
              tickFormatter={(v: number) => clockTime(new Date(v).toISOString(), locale, !!withDate)}
              tick={AXIS_TICK}
              stroke="var(--color-line-strong)"
              tickLine={false}
              minTickGap={56}
            />
            <YAxis yAxisId="main" tick={AXIS_TICK} tickFormatter={(v: number) => yFormat(v)} stroke="var(--color-line)" tickLine={false} axisLine={false} width={60} domain={yDomain ?? [0, 'auto']} />
            <YAxis yAxisId="band" orientation="right" domain={[0, 100]} hide />
            <YAxis yAxisId="count" orientation="right" hide />
            <Tooltip cursor={{ stroke: 'var(--color-line-strong)', strokeWidth: 1 }} content={<ChartTooltip series={series} locale={locale} yFormat={yFormat} />} isAnimationActive={false} />
            {series.map((s) => {
              if (s.kind === 'band')
                return <Area key={s.key} yAxisId="band" dataKey={s.key} type="step" stroke="none" fill={s.color} fillOpacity={0.22} isAnimationActive={false} connectNulls={false} />;
              if (s.kind === 'bar') return <Bar key={s.key} yAxisId="count" dataKey={s.key} fill={s.color} fillOpacity={0.6} isAnimationActive={false} maxBarSize={6} radius={[2, 2, 0, 0]} />;
              if (s.kind === 'faint') return <Line key={s.key} yAxisId="main" dataKey={s.key} stroke={s.color} strokeWidth={1} strokeOpacity={0.45} dot={false} isAnimationActive={false} connectNulls={false} />;
              if (s.kind === 'area')
                return <Area key={s.key} yAxisId="main" dataKey={s.key} type="monotone" stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.1} dot={dense} isAnimationActive={false} connectNulls={false} />;
              return <Line key={s.key} yAxisId="main" dataKey={s.key} type="monotone" stroke={s.color} strokeWidth={2} dot={dense ? { r: 3 } : false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-surface)' }} isAnimationActive={false} connectNulls={false} />;
            })}
          </ComposedChart>
        </ResponsiveContainer>
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
