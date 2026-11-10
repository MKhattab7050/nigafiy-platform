'use client';

import type { DevicePort, PortHistory, PortLocation } from '@lan-detective/shared-types';
import { Cable } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Async, Badge, Segmented, Spinner } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { absoluteTime, bps, clockTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { locationLine, portsText } from '@/lib/ports-text';

const TONE = { high: 'ok', medium: 'warn', low: 'idle' } as const;

/** One located device: the sentence, how sure, and the observations behind it. */
export function LocationView({ loc }: { loc: PortLocation }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Cable className="size-4 shrink-0 text-accent" aria-hidden />
        <Link href={`/ports?switch=${loc.target_id}`} className="font-medium hover:text-accent-hover" dir="auto">
          {locationLine(loc, locale)}
        </Link>
        <Badge tone={TONE[loc.confidence]} dot={false}>
          {tx.confidence[loc.confidence]}
        </Badge>
        {loc.vlan > 0 && <Badge tone="idle" dot={false}>VLAN {loc.vlan}</Badge>}
      </p>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">{tx.why}</summary>
        <ul className="mt-1 list-disc space-y-0.5 ps-5">
          {loc.evidence.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Device page card. */
export function DevicePortCard({ deviceId }: { deviceId: string }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const q = useQuery<DevicePort>(`/devices/${deviceId}/port`, ['devices'], 60_000);
  if (!q.data) return <Spinner />;
  const d = q.data;
  if (d.location) {
    const others = d.seen_on.filter((s) => !(s.target_id === d.location!.target_id && s.port_name === d.location!.port_name));
    return (
      <div className="space-y-2">
        <LocationView loc={d.location} />
        {others.length > 0 && (
          <p className="text-xs text-faint">
            {tx.alsoSeen}: {others.map((s) => `${s.switch_name} ${s.port_name}`).join(locale === 'ar' ? '، ' : ', ')}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>{d.reason === 'no_switches' ? tx.cardNone : tx.notLocated[d.reason ?? 'not_seen']}</p>
      <Link href="/ports" className="text-accent hover:underline">
        {tx.open}
      </Link>
    </div>
  );
}

const HISTORY_RANGES = ['6h', '24h', '7d', '30d'] as const;

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
      <Async query={q}>
        {(h) => {
          if (!h.points.length) return <p className="py-6 text-center text-xs leading-relaxed text-faint">{tx.historyEmpty}</p>;
          const data = h.points.map((p) => ({ ...p, t: new Date(p.ts).getTime(), faults: p.errors + p.discards || null, down: p.up ? null : 1 }));
          const maxIn = Math.max(0, ...h.points.map((p) => p.in_max_bps ?? 0));
          const maxOut = Math.max(0, ...h.points.map((p) => p.out_max_bps ?? 0));
          const faults = h.points.reduce((n, p) => n + p.errors, 0);
          const drops = h.points.reduce((n, p) => n + p.discards, 0);
          return (
            <div>
              <div className="h-44" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--color-line)" vertical={false} />
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="time"
                      domain={[new Date(h.from).getTime(), new Date(h.to).getTime()]}
                      tickFormatter={(v: number) => clockTime(new Date(v).toISOString(), locale, withDate)}
                      tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                      stroke="var(--color-line)"
                      tickLine={false}
                      minTickGap={48}
                    />
                    <YAxis yAxisId="bps" tickFormatter={(v: number) => bps(v)} tick={{ fill: 'var(--color-faint)', fontSize: 11 }} stroke="var(--color-line)" tickLine={false} axisLine={false} width={72} />
                    <YAxis yAxisId="n" orientation="right" hide allowDecimals={false} />
                    <YAxis yAxisId="flag" orientation="right" hide domain={[0, 1]} />
                    <Tooltip
                      cursor={{ stroke: 'var(--color-line-strong)' }}
                      contentStyle={{ background: 'var(--color-raised)', border: '1px solid var(--color-line-strong)', borderRadius: 6, fontSize: 12 }}
                      labelStyle={{ color: 'var(--color-muted)' }}
                      labelFormatter={(v) => absoluteTime(new Date(Number(v)).toISOString(), locale)}
                      formatter={(value, name) =>
                        name === 'in_bps'
                          ? [bps(Number(value)), tx.trafficIn]
                          : name === 'out_bps'
                            ? [bps(Number(value)), tx.trafficOut]
                            : name === 'down'
                              ? ['', tx.linkDown]
                              : [String(value), `${tx.errorsIn} + ${tx.discardsIn}`]
                      }
                    />
                    <Area yAxisId="flag" dataKey="down" type="step" stroke="none" fill="var(--color-idle)" fillOpacity={0.25} isAnimationActive={false} connectNulls={false} />
                    <Bar yAxisId="n" dataKey="faults" fill="var(--color-crit)" fillOpacity={0.55} isAnimationActive={false} maxBarSize={6} />
                    <Line yAxisId="bps" dataKey="in_bps" stroke="var(--color-accent)" strokeWidth={1.75} dot={data.length < 3} isAnimationActive={false} connectNulls={false} />
                    <Line yAxisId="bps" dataKey="out_bps" stroke="var(--color-cyan)" strokeWidth={1.75} dot={data.length < 3} isAnimationActive={false} connectNulls={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <p className="tnum mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                <span>
                  <span className="text-accent-hover">━</span> {tx.trafficIn}: {tx.trafficMax} {bps(maxIn)}
                </span>
                <span>
                  <span className="text-cyan">━</span> {tx.trafficOut}: {tx.trafficMax} {bps(maxOut)}
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
