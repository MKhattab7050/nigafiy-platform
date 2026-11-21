'use client';

import clsx from 'clsx';
import { useState } from 'react';
import { ChartTable } from './chart-table';

export interface Column {
  key: string;
  /** Axis label (short, e.g. a day). */
  label: string;
  /** Full label for the readout and the table. */
  title: string;
  /** Stacked parts, drawn bottom-up in the given order. */
  parts: { key: string; label: string; value: number; color: string }[];
}

/**
 * Counts per time slot as vertical stacked columns (incidents per day). Hover or focus a column
 * to read its exact numbers; the table below repeats them.
 */
export function ColumnChart({ columns, label, height = 120, valueLabel }: { columns: Column[]; label: string; height?: number; valueLabel: string }) {
  const [active, setActive] = useState<number | null>(null);
  const totals = columns.map((c) => c.parts.reduce((n, p) => n + p.value, 0));
  const top = Math.max(1, ...totals);
  const ticks = top <= 4 ? Array.from({ length: top + 1 }, (_, i) => i) : [0, Math.round(top / 2), top];
  const shown = active === null ? null : columns[active];
  const partKeys = columns[0]?.parts.map((p) => ({ key: p.key, label: p.label, color: p.color })) ?? [];
  return (
    <figure className="min-w-0">
      <div className="mb-2 flex min-h-5 flex-wrap items-center justify-between gap-2 text-[11.5px]">
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-muted">
          {partKeys.map((p) => (
            <li key={p.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[2px]" style={{ background: p.color }} aria-hidden />
              {p.label}
            </li>
          ))}
        </ul>
        {shown && (
          <span className="tnum text-muted" aria-live="polite">
            {shown.title}: {shown.parts.map((p) => `${p.label} ${p.value}`).join(' · ')}
          </span>
        )}
      </div>
      <div className="flex gap-2" dir="ltr">
        <div className="tnum relative w-6 shrink-0 text-end text-[10.5px] text-faint" style={{ height }} aria-hidden>
          {ticks.map((v) => (
            <span key={v} className="absolute end-0 -translate-y-1/2" style={{ top: `${(1 - v / top) * 100}%` }}>
              {v}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height }} role="img" aria-label={label}>
          {ticks.map((v) => (
            <span key={v} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: `${(1 - v / top) * 100}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end gap-[3px]" onMouseLeave={() => setActive(null)}>
            {columns.map((c, i) => (
              <button
                key={c.key}
                type="button"
                tabIndex={-1}
                aria-hidden
                onMouseEnter={() => setActive(i)}
                className={clsx('relative flex h-full flex-1 flex-col-reverse items-stretch rounded-t-[3px] focus:outline-none', active === i && 'bg-raised/70')}
              >
                {c.parts.map((p) =>
                  p.value > 0 ? <span key={p.key} className="block w-full first:rounded-b-none last:rounded-t-[3px]" style={{ height: `${(p.value / top) * 100}%`, background: p.color, minHeight: 2, marginTop: 1 }} /> : null,
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="ms-8 mt-1 flex justify-between gap-1 text-[10.5px] text-faint" dir="ltr" aria-hidden>
        {columns.map((c, i) => (
          <span key={c.key} className={clsx('flex-1 truncate text-center', columns.length > 10 && i % 2 === 1 && 'invisible')}>
            {c.label}
          </span>
        ))}
      </div>
      <ChartTable caption={label} columns={['', ...partKeys.map((p) => p.label), valueLabel]} rows={columns.map((c, i) => [c.title, ...c.parts.map((p) => p.value), totals[i]!])} />
    </figure>
  );
}
