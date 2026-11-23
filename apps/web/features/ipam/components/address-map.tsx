'use client';

import type { IpamSubnetDetail } from '@nigafiy/shared-types';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Button, Field, Input, Select } from '@/components/ui';
import { fill, useI18n } from '@/lib/i18n';
import { ipamText } from '../text';
import { canonicalIp, formatCount, ipToInt, intToIp, parseIp, parseSubnet } from '../subnet-calc';

// ── address map ─────────────────────────────────────────────────────────────

export const CELL = {
  conflict: 'border-crit bg-crit/20 text-fg hover:bg-crit/30',
  online: 'border-ok/50 bg-ok/20 text-fg hover:bg-ok/30',
  seen: 'border-idle/50 bg-idle/25 text-muted hover:bg-idle/35',
  documented: 'border-accent/50 bg-accent/15 text-fg hover:bg-accent/25',
  free: 'border-line bg-bg text-faint hover:border-line-strong hover:text-muted',
  special: 'cursor-default border-dashed border-line text-faint/50',
} as const;

type Look = keyof typeof CELL;

/** IPv4: a grid of every address, 256 at a time. IPv6: the sparse list (AddressList6). */
export function AddressMap({ subnet, onPick, onPage }: { subnet: IpamSubnetDetail; onPick: (ip: string) => void; onPage: (offset: number) => void }) {
  if (subnet.family === 6 || subnet.broadcast === null) return <AddressList6 subnet={subnet} onPick={onPick} onPage={onPage} />;
  return <AddressGrid4 subnet={subnet} broadcastIp={subnet.broadcast} onPick={onPick} />;
}

function AddressGrid4({ subnet, broadcastIp, onPick }: { subnet: IpamSubnetDetail; broadcastIp: string; onPick: (ip: string) => void }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const network = ipToInt(subnet.network)!;
  const broadcast = ipToInt(broadcastIp)!;
  const first = ipToInt(subnet.first_host)!;
  const last = ipToInt(subnet.last_host)!;
  const total = broadcast - network + 1;
  const blocks = Math.ceil(total / 256);
  const [block, setBlock] = useState(0);
  const start = network + Math.min(block, blocks - 1) * 256;
  const size = Math.min(256, total);
  const byIp = useMemo(() => new Map(subnet.addresses.map((a) => [ipToInt(a.ip)!, a])), [subnet.addresses]);
  const pool = subnet.dhcp ? { start: ipToInt(subnet.dhcp.start)!, end: ipToInt(subnet.dhcp.end)! } : null;

  const legend: [Look | 'pool', string][] = [
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
          const look: Look = special ? 'special' : lookOf(a);
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
      <Legend items={legend} />
    </div>
  );
}

const lookOf = (a: IpamSubnetDetail['addresses'][number] | undefined): Look =>
  a?.conflict ? 'conflict' : a?.state === 'online' ? 'online' : a?.devices.length ? 'seen' : a?.record ? 'documented' : 'free';

function Legend({ items }: { items: [Look | 'pool', string][] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
      {items.map(([k, text]) => (
        <li key={k} className="flex items-center gap-1.5">
          <span aria-hidden className={clsx('inline-block size-3 rounded-sm border', k === 'pool' ? 'border-line border-b-2 border-b-cyan' : CELL[k])} />
          {text}
        </li>
      ))}
    </ul>
  );
}

/**
 * IPv6: a /64 holds 2^64 addresses, so nothing is drawn per address. The observed, documented and
 * infrastructure addresses are listed (paged by the API), and any other address of the subnet can be
 * opened by typing it.
 */
function AddressList6({ subnet, onPick, onPage }: { subnet: IpamSubnetDetail; onPick: (ip: string) => void; onPage: (offset: number) => void }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const range = useMemo(() => parseSubnet(subnet.cidr), [subnet.cidr]);
  const [other, setOther] = useState('');
  const typed = parseIp(other);
  const valid = Boolean(typed && range && typed.family === range.family && typed.value >= range.first && typed.value <= range.last);
  const pool = subnet.dhcp ? { start: parseIp(subnet.dhcp.start)?.value, end: parseIp(subnet.dhcp.end)?.value } : null;
  const total = subnet.addresses_total;
  const from = subnet.addresses_offset;
  const to = from + subnet.addresses.length;
  const pageSize = Math.max(subnet.addresses.length, 1);
  const size = range ? formatCount(range.total) : null;

  return (
    <div>
      <p className="text-xs leading-relaxed text-muted">
        {fill(tx.v6MapIntro, { count: size ? (size.power !== null ? `2^${size.power}` : size.digits) : '' })}
      </p>
      {total === 0 ? (
        <p className="mt-3 text-[13px] text-muted">{tx.v6MapEmpty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-md border border-line text-[13px]">
          {subnet.addresses.map((a) => {
            const v = parseIp(a.ip)?.value;
            const inPool = pool !== null && v !== undefined && pool.start !== undefined && pool.end !== undefined && v >= pool.start && v <= pool.end;
            const anycast = a.ip === subnet.network;
            const stateText = anycast ? tx.anycastAddress : a.conflict ? tx.conflictKind[a.conflict] : a.devices.length || a.record ? tx.state[a.state] : tx.freeState;
            const who = a.devices[0]?.label ?? a.record?.label;
            return (
              <li key={a.ip}>
                <button
                  type="button"
                  disabled={anycast}
                  onClick={() => onPick(a.ip)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-start hover:bg-raised/60 disabled:cursor-default"
                >
                  <span aria-hidden className={clsx('inline-block size-3 shrink-0 rounded-sm border', CELL[anycast ? 'special' : lookOf(a)], inPool && 'border-b-2 border-b-cyan')} />
                  <span dir="ltr" className={clsx('mono break-all', a.flags.some((f) => f.startsWith('gateway')) && 'font-bold')}>
                    {a.ip}
                  </span>
                  <span dir="auto" className="text-xs text-muted">
                    {[stateText, who, ...a.flags.map((f) => tx.flag[f])].filter(Boolean).join(' · ')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {total > subnet.addresses.length && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="tnum">{fill(tx.v6Page, { from: from + 1, to, total })}</span>
          <Button size="sm" disabled={from === 0} onClick={() => onPage(Math.max(0, from - pageSize))}>
            {tx.previous}
          </Button>
          <Button size="sm" disabled={to >= total} onClick={() => onPage(to)}>
            {tx.next}
          </Button>
        </div>
      )}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onPick(canonicalIp(other));
        }}
      >
        <div className="min-w-0 flex-1">
          <Field
            label={tx.documentOther}
            hint={fill(tx.documentOtherHint, { example: subnet.next_free[0] ?? subnet.first_host })}
            error={other.trim() && !valid ? tx.documentOtherInvalid : undefined}
          >
            {(id) => <Input id={id} dir="ltr" className="mono" value={other} onChange={(e) => setOther(e.target.value)} maxLength={45} spellCheck={false} autoComplete="off" />}
          </Field>
        </div>
        <Button type="submit" size="sm" disabled={!valid}>
          {tx.open}
        </Button>
      </form>
      <Legend
        items={[
          ['online', tx.legend.online],
          ['seen', tx.legend.offline],
          ['documented', tx.legend.documented],
          ['conflict', tx.legend.conflict],
          ...(pool ? ([['pool', tx.legend.pool]] as ['pool', string][]) : []),
        ]}
      />
    </div>
  );
}
