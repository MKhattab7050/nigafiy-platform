'use client';

import type { PortHistory } from '@lan-detective/shared-types';
import { useState } from 'react';
import { TimeSeriesChart } from '@/components/charts';
import { Async, Segmented, SkeletonBlock } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { bps } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { portsText } from '../text';

export const HISTORY_RANGES = ['6h', '24h', '7d', '30d'] as const;

/** Traffic in / out and new errors of one switch port over time. Gaps are real: no rate could be derived there. */
export function PortHistoryChart({ switchId, ifIndex }: { switchId: string; ifIndex: number }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const [range, setRange] = useState<(typeof HISTORY_RANGES)[number]>('24h');
  const q = useQuery<PortHistory>(`/switches/${switchId}/ports/${ifIndex}/history?range=${range}`, ['devices'], 60_000);
  const withDate = range === '7d' || range === '30d';
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <Segmented label={tx.traffic} value={range} onChange={setRange} options={HISTORY_RANGES.map((r) => ({ value: r, label: r }))} />
      </div>
      <Async query={q} skeleton={<SkeletonBlock chart lines={1} />}>
        {(h) => {
          if (!h.points.length) return <p className="py-6 text-center text-xs leading-relaxed text-faint">{tx.historyEmpty}</p>;
          const data = h.points.map((p) => ({ t: new Date(p.ts).getTime(), in_bps: p.in_bps, out_bps: p.out_bps, faults: p.errors + p.discards || null, down: p.up ? null : 100 }));
          const maxIn = Math.max(0, ...h.points.map((p) => p.in_max_bps ?? 0));
          const maxOut = Math.max(0, ...h.points.map((p) => p.out_max_bps ?? 0));
          const faults = h.points.reduce((n, p) => n + p.errors, 0);
          const drops = h.points.reduce((n, p) => n + p.discards, 0);
          return (
            <div>
              <TimeSeriesChart
                data={data}
                from={new Date(h.from).getTime()}
                to={new Date(h.to).getTime()}
                withDate={withDate}
                label={tx.traffic}
                yFormat={(v) => bps(v)}
                series={[
                  { key: 'in_bps', label: tx.trafficIn, color: 'var(--color-series-1)' },
                  { key: 'out_bps', label: tx.trafficOut, color: 'var(--color-series-2)' },
                  { key: 'faults', label: `${tx.errorsIn} + ${tx.discardsIn}`, color: 'var(--color-crit)', kind: 'bar', format: (v) => String(v) },
                  { key: 'down', label: tx.linkDown, color: 'var(--color-idle)', kind: 'band', format: () => tx.linkDown },
                ]}
              />
              <p className="tnum mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
                <span>
                  {tx.trafficIn}: {tx.trafficMax} {bps(maxIn)}
                </span>
                <span>
                  {tx.trafficOut}: {tx.trafficMax} {bps(maxOut)}
                </span>
                <span className={faults + drops > 0 ? 'text-crit' : undefined}>
                  {faults} {tx.errorsIn} · {drops} {tx.discardsIn}
                </span>
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-faint">{tx.historyNote}</p>
            </div>
          );
        }}
      </Async>
    </div>
  );
}
