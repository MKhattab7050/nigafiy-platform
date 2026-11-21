'use client';

import { useId } from 'react';

/**
 * A word-sized trend line. `null` values are real gaps (no samples), never bridged.
 * Purely visual: the surrounding text must state the current value; `label` describes the trend.
 */
export function Sparkline({
  values,
  color = 'var(--color-series-1)',
  height = 28,
  label,
  area = true,
  min,
  max,
  className,
}: {
  values: (number | null)[];
  color?: string;
  height?: number;
  label: string;
  area?: boolean;
  min?: number;
  max?: number;
  className?: string;
}) {
  const gradient = useId();
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length < 2) return null;
  const lo = min ?? Math.min(...nums);
  const hi = max ?? Math.max(...nums);
  const span = hi - lo || 1;
  const W = 100;
  const H = height;
  const pad = 2;
  const x = (i: number) => (values.length === 1 ? W / 2 : (i / (values.length - 1)) * W);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);

  // Split into runs of consecutive values so gaps stay gaps.
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push({ i, v });
  });
  if (run.length) runs.push(run);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className ?? 'h-7 w-full'} role="img" aria-label={label} style={{ direction: 'ltr' }}>
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {runs.map((r, k) => {
        const line = r.map((p, j) => `${j ? 'L' : 'M'}${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
        return (
          <g key={k}>
            {area && r.length > 1 && <path d={`${line} L${x(r[r.length - 1]!.i).toFixed(2)},${H} L${x(r[0]!.i).toFixed(2)},${H} Z`} fill={`url(#${gradient})`} />}
            <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}
    </svg>
  );
}
