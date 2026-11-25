'use client';

import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { absoluteTime, clockTime } from '@/lib/format';
import type { SeriesDef, TimePoint } from './time-series';

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

/** The Recharts part of TimeSeriesChart, in its own chunk (loaded with next/dynamic). */
export function TimeSeriesPlot({
  data,
  from,
  to,
  series,
  yFormat,
  yDomain,
  withDate,
  dense,
  locale,
}: {
  data: TimePoint[];
  from: number;
  to: number;
  series: SeriesDef[];
  yFormat: (v: number) => string;
  yDomain?: [number | 'auto', number | 'auto'];
  withDate?: boolean;
  dense: boolean;
  locale: 'en' | 'ar';
}) {
  return (
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
  );
}
