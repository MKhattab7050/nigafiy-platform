'use client';

import type { IpamAddress, IpamHistoryEntry, IpamRecordKind, IpamSubnetDetail } from '@lan-detective/shared-types';
import clsx from 'clsx';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge, Button, ErrorNote, Fact, Field, Input, Modal, Select, StatusBadge, Textarea, type Tone } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ipamText } from '@/lib/ipam-text';
import { type Subnet, intToIp, ipToInt, parseSubnet, splitSubnet } from '@/lib/subnet-calc';

export const STATE_TONE: Record<IpamAddress['state'], Tone> = { online: 'ok', offline: 'idle', unknown: 'idle', documented: 'info', infrastructure: 'idle' };

/** Stacked bar: online, seen-but-offline, documented-only; the remainder is free. Always paired with the numbers as text. */
export function UsageBar({ usable, online, offline, documented }: { usable: number; online: number; offline: number; documented: number }) {
  const w = (n: number) => `${usable > 0 ? Math.min(100, (n / usable) * 100) : 0}%`;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden>
      <span className="bg-ok" style={{ width: w(online) }} />
      <span className="bg-idle" style={{ width: w(offline) }} />
      <span className="bg-accent" style={{ width: w(documented) }} />
    </div>
  );
}

// ── subnet plan (documentation of the subnet itself) ────────────────────────

export function PlanModal({ subnet, onClose, onSaved }: { subnet: IpamSubnetDetail; onClose: () => void; onSaved: () => void }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const [vlan, setVlan] = useState(subnet.vlan_id?.toString() ?? '');
  const [gateway, setGateway] = useState(subnet.gateway?.source === 'documented' ? subnet.gateway.ip : '');
  const [start, setStart] = useState(subnet.dhcp?.start ?? '');
  const [end, setEnd] = useState(subnet.dhcp?.end ?? '');
  const [dns, setDns] = useState(subnet.dns_servers.join(', '));
  const [notes, setNotes] = useState(subnet.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/ipam/subnets/${subnet.id}`, {
        method: 'PUT',
        body: {
          vlan_id: vlan.trim() ? Number(vlan) : null,
          gateway: gateway.trim() || null,
          dns_servers: dns.split(/[\s,،]+/).filter(Boolean),
          dhcp_start: start.trim() || null,
          dhcp_end: end.trim() || null,
          notes: notes.trim() || null,
        },
      });
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${tx.edit} · ${subnet.cidr}`} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tx.formGateway} hint={tx.formGatewayHint}>
          {(id) => <Input id={id} dir="ltr" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder={subnet.first_host} maxLength={15} />}
        </Field>
        <Field label={tx.formVlan}>{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={vlan} onChange={(e) => setVlan(e.target.value.replace(/\D/g, ''))} maxLength={4} />}</Field>
        <Field label={tx.formDhcpStart}>{(id) => <Input id={id} dir="ltr" value={start} onChange={(e) => setStart(e.target.value)} maxLength={15} />}</Field>
        <Field label={tx.formDhcpEnd} hint={tx.dhcpNote}>
          {(id) => <Input id={id} dir="ltr" value={end} onChange={(e) => setEnd(e.target.value)} maxLength={15} />}
        </Field>
        <div className="sm:col-span-2">
          <Field label={tx.formDns} hint={tx.formDnsHint}>
            {(id) => <Input id={id} dir="ltr" value={dns} onChange={(e) => setDns(e.target.value)} maxLength={80} />}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={tx.notes}>{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />}</Field>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" busy={busy} onClick={save}>
          {tx.save}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {tx.cancel}
        </Button>
      </div>
    </Modal>
  );
}

// ── one address: what is observed, what is documented, who used it ──────────

export function AddressModal({ subnet, ip, onClose, onChanged }: { subnet: IpamSubnetDetail; ip: string; onClose: () => void; onChanged: () => void }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const { can } = useApp();
  const entry = subnet.addresses.find((a) => a.ip === ip) ?? null;
  const record = entry?.record ?? null;
  const editable = can('technician');
  const history = useQuery<{ items: IpamHistoryEntry[] }>(`/ipam/history${qs({ site_id: subnet.site_id, ip })}`, ['devices'], 60_000);

  const [kind, setKind] = useState<IpamRecordKind>(record?.kind ?? 'static');
  const [label, setLabel] = useState(record?.label ?? '');
  const [mac, setMac] = useState(record?.mac ?? '');
  const [notes, setNotes] = useState(record?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const observedMac = entry?.devices.find((d) => d.mac)?.mac ?? null;
  const n = ipToInt(ip)!;
  const inPool = subnet.dhcp ? n >= ipToInt(subnet.dhcp.start)! && n <= ipToInt(subnet.dhcp.end)! : false;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      onClose();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  }
  const save = () =>
    run(() => {
      const body = { kind, label: label.trim(), mac: kind === 'reserved' ? null : mac.trim() || null, notes: notes.trim() || null };
      return record ? api(`/ipam/addresses/${record.id}`, { method: 'PATCH', body }) : api('/ipam/addresses', { method: 'POST', body: { site_id: subnet.site_id, ip, ...body } });
    });
  const ready = label.trim().length > 0 && (kind !== 'dhcp_reservation' || mac.trim().length > 0);

  return (
    <Modal title={ip} onClose={onClose} wide>
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted">
            {tx.observed}
            {entry?.flags.map((f) => (
              <Badge key={f} tone="info" dot={false}>
                {tx.flag[f]}
              </Badge>
            ))}
            {!entry && inPool && (
              <Badge tone="info" dot={false}>
                {tx.flag.dhcp_pool}
              </Badge>
            )}
          </h3>
          {entry && entry.devices.length > 0 ? (
            <ul className="space-y-1.5">
              {entry.devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <StatusBadge status={d.status} />
                  <Link href={`/devices/${d.id}`} className="font-medium hover:text-accent-hover" dir="auto">
                    {d.label}
                  </Link>
                  {d.mac && <span className="mono text-xs text-muted">{d.mac}</span>}
                  <span className="text-xs text-faint">
                    {tx.lastSeen} {relativeTime(d.last_seen_at, locale)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">{entry?.record || entry?.flags.length ? tx.observedNone : tx.observedFree}</p>
          )}
          {entry?.conflict && (
            <div role="alert" className="mt-3 rounded-md border border-crit/30 bg-crit/10 px-3 py-2 text-[13px]">
              <p className="font-medium">{tx.conflictKind[entry.conflict]}</p>
              <p className="mt-0.5 text-xs text-muted">{tx.conflictHelp[entry.conflict]}</p>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted">{record ? tx.documented : tx.document}</h3>
          {editable ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={tx.fieldKind} hint={tx.kindHint[kind]}>
                {(id) => (
                  <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as IpamRecordKind)}>
                    {(['static', 'dhcp_reservation', 'reserved'] as const).map((k) => (
                      <option key={k} value={k}>
                        {tx.kind[k]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={tx.fieldLabel}>{(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />}</Field>
              {kind !== 'reserved' && (
                <div className="sm:col-span-2">
                  <Field label={tx.fieldMac} hint={kind === 'dhcp_reservation' ? tx.fieldMacRequired : tx.fieldMacHint}>
                    {(id) => (
                      <div className="flex gap-2">
                        <Input id={id} dir="ltr" className="mono" value={mac} onChange={(e) => setMac(e.target.value)} placeholder="00:11:22:33:44:55" maxLength={17} spellCheck={false} />
                        {observedMac && observedMac !== mac.trim().toLowerCase() && (
                          <Button className="h-9" onClick={() => setMac(observedMac)}>
                            {tx.useObserved}
                          </Button>
                        )}
                      </div>
                    )}
                  </Field>
                </div>
              )}
              <div className="sm:col-span-2">
                <Field label={tx.fieldNotes}>{(id) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />}</Field>
              </div>
            </div>
          ) : record ? (
            <dl>
              <Fact label={tx.fieldKind}>{tx.kind[record.kind]}</Fact>
              <Fact label={tx.fieldLabel}>
                <span dir="auto">{record.label}</span>
              </Fact>
              {record.mac && (
                <Fact label={tx.fieldMac}>
                  <span className="mono">{record.mac}</span>
                </Fact>
              )}
              {record.notes && (
                <Fact label={tx.fieldNotes}>
                  <span dir="auto">{record.notes}</span>
                </Fact>
              )}
            </dl>
          ) : (
            <p className="text-[13px] text-muted">{tx.readOnly}</p>
          )}
          {error && (
            <div className="mt-3">
              <ErrorNote error={error} />
            </div>
          )}
          {editable && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" busy={busy} disabled={!ready} onClick={save}>
                {tx.save}
              </Button>
              {record && (
                <Button variant="danger" disabled={busy} onClick={() => run(() => api(`/ipam/addresses/${record.id}`, { method: 'DELETE' }))}>
                  {tx.remove}
                </Button>
              )}
              <Button variant="ghost" onClick={onClose}>
                {tx.cancel}
              </Button>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted">{tx.history}</h3>
          {history.data && history.data.items.length === 0 && <p className="text-[13px] text-muted">{tx.historyNone}</p>}
          <ul className="divide-y divide-line text-[13px]">
            {history.data?.items.map((h) => (
              <li key={h.device_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <Link href={`/devices/${h.device_id}`} className="font-medium hover:text-accent-hover" dir="auto">
                  {h.label}
                </Link>
                {h.mac && <span className="mono text-xs text-muted">{h.mac}</span>}
                <span className="ms-auto text-xs text-faint">
                  {relativeTime(h.first_seen_at, locale)} → {h.current ? tx.now : relativeTime(h.last_seen_at, locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}

// ── address map ─────────────────────────────────────────────────────────────

const CELL = {
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

// ── subnet calculator (works offline, nothing is sent anywhere) ─────────────

export function SubnetCalculator({ initial }: { initial?: string }) {
  const { locale } = useI18n();
  const tx = ipamText(locale).calc;
  const [text, setText] = useState(initial ?? '192.168.1.0/24');
  const s = useMemo(() => parseSubnet(text), [text]);
  const [splitTo, setSplitTo] = useState<number | null>(null);
  const newPrefix = s ? Math.min(32, Math.max(s.prefix + 1, splitTo ?? s.prefix + 1)) : 0;
  const split = s && s.prefix < 32 ? splitSubnet(s, newPrefix, 64) : null;
  const num = (n: number) => n.toLocaleString('en-US');
  const range = (x: Subnet) => (x.usable === 1 ? intToIp(x.first) : `${intToIp(x.first)} – ${intToIp(x.last)}`);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-lg border border-line bg-surface p-4">
        <Field label={tx.input} hint={tx.hint} error={text.trim() && !s ? tx.invalid : undefined}>
          {(id) => <Input id={id} dir="ltr" className="mono" value={text} onChange={(e) => setText(e.target.value)} maxLength={40} spellCheck={false} autoComplete="off" />}
        </Field>
        {s && (
          <>
            <div className="mt-4" dir="ltr" aria-hidden>
              <div className="flex gap-px">
                {Array.from({ length: 32 }, (_, i) => (
                  <span key={i} className={clsx('h-3 flex-1 rounded-[2px]', i < s.prefix ? 'bg-accent' : 'bg-ok/60', i % 8 === 0 && i > 0 && 'ms-1')} />
                ))}
              </div>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {tx.bits}: <span className="text-accent-hover">{s.prefix} {tx.networkBits}</span> · <span className="text-ok">{32 - s.prefix} {tx.hostBits}</span>
            </p>
            <dl className="mt-3">
              <Fact label={tx.network}>
                <span className="mono">
                  {intToIp(s.network)}/{s.prefix}
                </span>
              </Fact>
              <Fact label={tx.netmask}>
                <span className="mono">{s.netmask}</span>
              </Fact>
              <Fact label={tx.wildcard}>
                <span className="mono">{s.wildcard}</span>
              </Fact>
              <Fact label={tx.range}>
                <span className="mono">{range(s)}</span>
              </Fact>
              <Fact label={tx.broadcast}>
                <span className="mono">{s.prefix >= 31 ? '—' : intToIp(s.broadcast)}</span>
              </Fact>
              <Fact label={tx.usable}>
                <span className="tnum">{num(s.usable)}</span>
              </Fact>
              <Fact label={tx.total}>
                <span className="tnum">{num(s.total)}</span>
              </Fact>
              <Fact label={tx.kind}>{tx.kinds[s.kind]}</Fact>
            </dl>
          </>
        )}
      </section>
      {s && split && (
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-[13px] font-semibold">{tx.split}</h2>
          <div className="max-w-40">
            <Field label={tx.splitInto}>
              {(id) => (
                <Select id={id} dir="ltr" value={newPrefix} onChange={(e) => setSplitTo(Number(e.target.value))}>
                  {Array.from({ length: 32 - s.prefix }, (_, i) => s.prefix + 1 + i).map((p) => (
                    <option key={p} value={p}>
                      /{p}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <p className="mt-3 text-xs text-muted tnum">
            {num(split.count)} {tx.splitCount} · {num(split.items[0]!.usable)} {tx.hostsEach}
            {split.count > split.items.length && ` · ${split.items.length} ${tx.splitShown}`}
          </p>
          <ul dir="ltr" className="mt-2 max-h-96 divide-y divide-line overflow-y-auto text-xs">
            {split.items.map((x) => (
              <li key={x.network} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-1.5">
                <span className="mono font-medium">
                  {intToIp(x.network)}/{x.prefix}
                </span>
                <span className="mono text-muted">{range(x)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
