'use client';

import type { IpamSubnetDetail } from '@lan-detective/shared-types';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Field, Select } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ipamText } from '../text';
import { ipToInt, intToIp } from '../subnet-calc';

// ── address map ─────────────────────────────────────────────────────────────

export const CELL = {
  conflict: 'border-crit bg-crit/20 text-fg hover:bg-crit/30',
  online: 'border-ok/50 bg-ok/20 text-fg hover:bg-ok/30',
  seen: 'border-idle/50 bg-idle/25 text-muted hover:bg-idle/35',
  documented: 'border-accent/50 bg-accent/15 text-fg hover:bg-accent/25',
  free: 'border-line bg-bg text-faint hover:border-line-strong hover:text-muted',
  special: 'cursor-default border-dashed border-line text-faint/50',
} as const;

export function AddressMap({ subnet, onPick }: { subnet: IpamSubnetDetail; onPick: (ip: string) => void }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const network = ipToInt(subnet.network)!;
  const broadcast = ipToInt(subnet.broadcast)!;
  const first = ipToInt(subnet.first_host)!;
  const last = ipToInt(subnet.last_host)!;
  const total = broadcast - network + 1;
  const blocks = Math.ceil(total / 256);
  const [block, setBlock] = useState(0);
  const start = network + Math.min(block, blocks - 1) * 256;
  const size = Math.min(256, total);
  const byIp = useMemo(() => new Map(subnet.addresses.map((a) => [ipToInt(a.ip)!, a])), [subnet.addresses]);
  const pool = subnet.dhcp ? { start: ipToInt(subnet.dhcp.start)!, end: ipToInt(subnet.dhcp.end)! } : null;

  const legend: [keyof typeof CELL | 'pool', string][] = [
    ['online', tx.legend.online],
    ['seen', tx.legend.offline],
    ['documented', tx.legend.documented],
    ['conflict', tx.legend.conflict],
    ['free', tx.legend.free],
    ...(pool ? ([['pool', tx.legend.pool]] as [ 'pool', string][]) : []),
  ];

  return (
    <div>
      {blocks > 1 && (
        <div className="mb-3 max-w-56">
          <Field label={tx.block}>
            {(id) => (
              <Select id={id} dir="ltr" value={block} onChange={(e) => setBlock(Number(e.target.value))}>
                {Array.from({ length: blocks }, (_, i) => (
                  <option key={i} value={i}>
                    {intToIp(network + i * 256)} – {intToIp(Math.min(broadcast, network + i * 256 + 255))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
      <div dir="ltr" className="grid grid-cols-8 gap-1 sm:grid-cols-16">
        {Array.from({ length: size }, (_, i) => {
          const n = start + i;
          const ip = intToIp(n);
          const a = byIp.get(n);
          const special = n < first || n > last;
          const look = special ? 'special' : a?.conflict ? 'conflict' : a?.state === 'online' ? 'online' : a && a.devices.length ? 'seen' : a?.record ? 'documented' : 'free';
          const stateText = special ? (n === network ? tx.networkAddress : tx.broadcastAddress) : a ? (a.conflict ? tx.conflictKind[a.conflict] : a.devices.length || a.record ? tx.state[a.state] : tx.freeState) : tx.freeState;
          const who = a?.devices[0]?.label ?? a?.record?.label;
          const flags = a?.flags.map((f) => tx.flag[f]).join(', ');
          const inPool = !special && pool !== null && n >= pool.start && n <= pool.end;
          const title = [ip, stateText, who, flags].filter(Boolean).join(' · ');
          return (
            <button
              key={n}
              type="button"
              disabled={special}
              onClick={() => onPick(ip)}
              title={title}
              aria-label={title}
              className={clsx('tnum h-7 rounded border text-[11px] leading-none transition-colors', CELL[look], inPool && 'border-b-2 border-b-cyan', a?.flags.some((f) => f.startsWith('gateway')) && 'font-bold underline')}
            >
              {n & 255}
            </button>
          );
        })}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
        {legend.map(([k, text]) => (
          <li key={k} className="flex items-center gap-1.5">
            <span aria-hidden className={clsx('inline-block size-3 rounded-sm border', k === 'pool' ? 'border-line border-b-2 border-b-cyan' : CELL[k])} />
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}
