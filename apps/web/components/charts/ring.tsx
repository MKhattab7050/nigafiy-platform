'use client';

import Link from 'next/link';
import { TONE, type Tone } from '@/components/ui/tones';

const polar = (r: number, turn: number) => {
  const a = turn * 2 * Math.PI - Math.PI / 2;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)] as const;
};

function arc(r: number, from: number, to: number) {
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  return `M${x1.toFixed(3)} ${y1.toFixed(3)} A${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
}

/**
 * A single value out of 100 as a ring (health score, compliance share). The number in the middle
 * is the value itself, so the ring is a reading aid, not the only carrier.
 */
export function RingGauge({ value, tone, size = 112, label, children, thickness = 9 }: { value: number; tone: Tone; size?: number; label: string; children?: React.ReactNode; thickness?: number }) {
  const v = Math.max(0, Math.min(100, value));
  const r = 50 - thickness / 2 - 1;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="size-full" role="img" aria-label={label}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-line)" strokeWidth={thickness} />
        {v > 0 && (
          <path d={v >= 100 ? arc(r, 0, 0.9999) : arc(r, 0, v / 100)} fill="none" stroke={TONE[tone].stroke} strokeWidth={thickness} strokeLinecap="round" className="transition-[d] duration-500" />
        )}
      </svg>
      {children && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>}
    </div>
  );
}

export interface Slice {
  key: string;
  label: string;
  value: number;
  /** A CSS colour (token var). */
  color: string;
}

/** Parts of a whole (≤ 5 slices). The legend beside it carries labels and counts. */
export function Donut({ slices, size = 96, label, children, thickness = 12 }: { slices: Slice[]; size?: number; label: string; children?: React.ReactNode; thickness?: number }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const r = 50 - thickness / 2 - 1;
  const gap = slices.filter((s) => s.value > 0).length > 1 ? 0.006 : 0;
  let at = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="size-full" role="img" aria-label={label}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-line)" strokeWidth={thickness} />
        {total > 0 &&
          slices.map((s) => {
            if (s.value <= 0) return null;
            const share = s.value / total;
            const from = at + gap;
            const to = at + share - gap;
            at += share;
            if (share >= 0.9999) return <circle key={s.key} cx="50" cy="50" r={r} fill="none" stroke={s.color} strokeWidth={thickness} />;
            if (to <= from) return null;
            return (
              <path key={s.key} d={arc(r, from, to)} fill="none" stroke={s.color} strokeWidth={thickness}>
                <title>{`${s.label}: ${s.value}`}</title>
              </path>
            );
          })}
      </svg>
      {children && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>}
    </div>
  );
}

/** Legend for donuts and proportion bars: swatch, label, count, share. */
export function Legend({ slices, total, hrefFor }: { slices: Slice[]; total?: number; hrefFor?: (s: Slice) => string | undefined }) {
  const sum = total ?? slices.reduce((n, s) => n + s.value, 0);
  return (
    <ul className="min-w-0 space-y-1.5 text-xs">
      {slices.map((s) => {
        const body = (
          <>
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-muted">{s.label}</span>
            <span className="tnum font-medium text-fg">{s.value}</span>
            {sum > 0 && <span className="tnum w-10 text-end text-faint">{Math.round((s.value / sum) * 100)}%</span>}
          </>
        );
        const href = hrefFor?.(s);
        return (
          <li key={s.key}>
            {href ? (
              <Link href={href} className="-mx-1 flex items-center gap-2 rounded-[5px] px-1 py-0.5 hover:bg-raised">
                {body}
              </Link>
            ) : (
              <span className="flex items-center gap-2 py-0.5">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
