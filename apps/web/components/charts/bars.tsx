'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { TONE, type Tone } from '@/components/ui/tones';
import type { Slice } from './ring';

/**
 * A 100 % stacked bar: how a whole splits into parts (online / offline / unknown, platforms).
 * Segments are separated by a 2 px gap; the legend underneath names them with counts.
 */
export function ProportionBar({ slices, label, height = 8, legend = true, hrefFor }: { slices: Slice[]; label: string; height?: number; legend?: boolean; hrefFor?: (s: Slice) => string | undefined }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  return (
    <div className="min-w-0">
      <div className="flex w-full gap-[2px] overflow-hidden rounded-full bg-line" style={{ height }} role="img" aria-label={`${label}: ${slices.map((s) => `${s.label} ${s.value}`).join(', ')}`}>
        {total > 0 &&
          slices
            .filter((s) => s.value > 0)
            .map((s) => <span key={s.key} className="h-full first:rounded-s-full last:rounded-e-full" style={{ width: `${(s.value / total) * 100}%`, background: s.color, minWidth: 3 }} />)}
      </div>
      {legend && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {slices.map((s) => {
            const body = (
              <>
                <span className="size-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
                <span className="text-muted">{s.label}</span>
                <span className="tnum font-medium text-fg">{s.value}</span>
              </>
            );
            const href = hrefFor?.(s);
            return (
              <li key={s.key}>
                {href ? (
                  <Link href={href} className="flex items-center gap-1.5 rounded hover:underline">
                    {body}
                  </Link>
                ) : (
                  <span className="flex items-center gap-1.5">{body}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Tone for a utilisation percentage: amber from `warn`, red from `crit`. */
export const loadTone = (pct: number | null | undefined, warn = 80, crit = 90): Tone => (pct === null || pct === undefined ? 'idle' : pct >= crit ? 'crit' : pct >= warn ? 'warn' : 'ok');

/** One measured share of a capacity (CPU, memory, disk, subnet). The number is always printed. */
export function Meter({
  label,
  value,
  display,
  detail,
  tone,
  warn = 80,
  crit = 90,
  size = 'md',
  ariaLabel,
}: {
  label: React.ReactNode;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
  /** 0–100, or null when not reported. */
  value: number | null | undefined;
  display?: React.ReactNode;
  detail?: React.ReactNode;
  tone?: Tone;
  warn?: number;
  crit?: number;
  size?: 'sm' | 'md';
}) {
  const v = value === null || value === undefined ? null : Math.max(0, Math.min(100, value));
  const tn = tone ?? (v === null ? 'idle' : loadTone(v, warn, crit));
  // Healthy load is drawn in the neutral accent; only the warning bands borrow the state colours.
  const fill = tn === 'ok' ? 'bg-accent' : TONE[tn].fill;
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className={clsx('min-w-0 truncate text-muted', size === 'sm' ? 'text-[11.5px]' : 'text-xs')}>{label}</span>
        <span className={clsx('tnum shrink-0 font-semibold', size === 'sm' ? 'text-xs' : 'text-[13px]', tn === 'warn' || tn === 'crit' ? TONE[tn].text : 'text-fg')}>{display ?? (v === null ? '—' : `${Math.round(v)}%`)}</span>
      </div>
      <div
        className={clsx('relative overflow-hidden rounded-full bg-line', size === 'sm' ? 'h-1.5' : 'h-2')}
        role="meter"
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v ?? undefined}
      >
        {v !== null && <span className={clsx('absolute inset-y-0 start-0 rounded-full transition-[width] duration-500', fill)} style={{ width: `${Math.max(v, 1)}%` }} />}
        {/* Threshold tick so "how close to the limit" reads without colour. */}
        <span className="absolute inset-y-0 w-px bg-fg/25" style={{ insetInlineStart: `${warn}%` }} aria-hidden />
      </div>
      {detail && <p className="mt-1 text-[11px] text-faint">{detail}</p>}
    </div>
  );
}

/** Ranked categories as horizontal bars in one hue (device types, top talkers). */
export function BarList({ items, label, color = 'var(--color-series-1)', max: maxItems = 6, otherLabel }: { items: { key: string; label: React.ReactNode; value: number; href?: string }[]; label: string; color?: string; max?: number; otherLabel?: string }) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const shown = sorted.slice(0, maxItems);
  const rest = sorted.slice(maxItems).reduce((n, i) => n + i.value, 0);
  const rows = rest > 0 && otherLabel ? [...shown, { key: '__other', label: otherLabel, value: rest, href: undefined }] : shown;
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2" aria-label={label}>
      {rows.map((r) => {
        const body = (
          <>
            <span className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-muted">{r.label}</span>
              <span className="tnum font-medium text-fg">{r.value}</span>
            </span>
            <span className="mt-1 block h-1.5 rounded-full bg-line" aria-hidden>
              <span className="block h-full rounded-full" style={{ width: `${(r.value / top) * 100}%`, background: color, minWidth: 3 }} />
            </span>
          </>
        );
        return (
          <li key={r.key}>
            {r.href ? (
              <Link href={r.href} className="block rounded-[5px] px-1 py-0.5 hover:bg-raised">
                {body}
              </Link>
            ) : (
              <div className="px-1 py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
