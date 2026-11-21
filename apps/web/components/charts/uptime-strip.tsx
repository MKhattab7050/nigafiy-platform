'use client';

import clsx from 'clsx';
import { useState } from 'react';
import { TONE, type Tone } from '@/components/ui/tones';
import { absoluteTime, pct } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export interface UptimeSample {
  /** Bucket start (ms). */
  t: number;
  samples: number;
  /** Share of successful samples, 0–1. */
  ok_ratio: number;
}

export interface UptimeCell {
  from: number;
  to: number;
  samples: number;
  ratio: number | null;
}

/** Re-buckets measured samples into `cells` equal slots between `from` and `to`. Slots without samples stay null. */
export function toCells(points: UptimeSample[], from: number, to: number, cells: number): UptimeCell[] {
  const size = (to - from) / cells;
  const out: UptimeCell[] = Array.from({ length: cells }, (_, i) => ({ from: from + i * size, to: from + (i + 1) * size, samples: 0, ratio: null }));
  const ok = new Array<number>(cells).fill(0);
  for (const p of points) {
    const i = Math.floor((p.t - from) / size);
    if (i < 0 || i >= cells || p.samples <= 0) continue;
    out[i]!.samples += p.samples;
    ok[i]! += p.samples * p.ok_ratio;
  }
  out.forEach((c, i) => {
    if (c.samples > 0) c.ratio = ok[i]! / c.samples;
  });
  return out;
}

export const uptimeTone = (ratio: number | null): Tone => (ratio === null ? 'idle' : ratio >= 0.999 ? 'ok' : ratio >= 0.95 ? 'warn' : 'crit');

/**
 * Availability heat row: one cell per time slot, coloured by the share of successful samples.
 * Empty (outlined) cells mean "no samples", which is not the same as "down".
 */
export function UptimeStrip({ cells, label, startLabel, endLabel = undefined, compact }: { cells: UptimeCell[]; label: string; startLabel: string; endLabel?: string; compact?: boolean }) {
  const { t, locale } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const measured = cells.filter((c) => c.ratio !== null);
  const total = measured.reduce((n, c) => n + c.samples, 0);
  const ok = measured.reduce((n, c) => n + c.samples * (c.ratio ?? 0), 0);
  const summary = total ? `${label}: ${pct((ok / total) * 100, 2)} (${total} ${t('overview.samples')})` : `${label}: ${t('common.noData')}`;
  const h = hover === null ? null : cells[hover];
  return (
    <div className="min-w-0">
      <div className={clsx('flex w-full items-stretch gap-[2px]', compact ? 'h-4' : 'h-6')} dir="ltr" role="img" aria-label={summary} onMouseLeave={() => setHover(null)}>
        {cells.map((c, i) => {
          const tone = uptimeTone(c.ratio);
          return (
            <span
              key={i}
              onMouseEnter={() => setHover(i)}
              className={clsx(
                'min-w-[2px] flex-1 rounded-[2px] transition-opacity',
                c.ratio === null ? 'border border-dashed border-line-strong bg-transparent' : tone === 'ok' ? 'bg-ok/70' : TONE[tone].fill,
                hover !== null && hover !== i && 'opacity-60',
              )}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between gap-2 text-[11px] text-faint" dir="ltr">
        <span>{startLabel}</span>
        {h ? (
          <span className="tnum truncate text-muted" dir="auto">
            {absoluteTime(new Date(h.from).toISOString(), locale)} · {h.ratio === null ? t('common.noData') : `${pct(h.ratio * 100, 1)} ${t('chart.ok')} · ${h.samples} ${t('overview.samples')}`}
          </span>
        ) : (
          !compact && total > 0 && <span className="tnum text-muted">{pct((ok / total) * 100, 2)}</span>
        )}
        <span>{endLabel ?? t('chart.now')}</span>
      </div>
    </div>
  );
}

/** Legend for uptime strips: what each cell colour means, in words. */
export function UptimeLegend() {
  const { t } = useI18n();
  const items: { cls: string; label: string }[] = [
    { cls: 'bg-ok/70', label: t('chart.uptime.full') },
    { cls: 'bg-warn', label: t('chart.uptime.partial') },
    { cls: 'bg-crit', label: t('chart.uptime.failing') },
    { cls: 'border border-dashed border-line-strong', label: t('chart.uptime.none') },
  ];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className={clsx('h-2.5 w-2 rounded-[2px]', i.cls)} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
