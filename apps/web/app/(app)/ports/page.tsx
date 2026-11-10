'use client';

import type { PortSearchHit, SwitchDetail, SwitchPort, SwitchSummary } from '@lan-detective/shared-types';
import { Cable, ChevronDown, ChevronUp, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { LocationView, PortHistoryChart } from '@/components/ports';
import { Async, Badge, Button, Card, EmptyState, ErrorNote, Field, Input, PageHeader, Select, StatusBadge } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { bps, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { portsText } from '@/lib/ports-text';

const STATUS_TONE = { ok: 'ok', error: 'crit', never: 'idle' } as const;
const ROLE_TONE = { edge: 'ok', shared: 'info', trunk: 'warn', uplink: 'info', idle: 'idle', down: 'idle' } as const;

function PortsView() {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const { siteId, sites, can } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const site = siteId ?? sites[0]?.id ?? null;
  const list = useQuery<{ items: SwitchSummary[] }>(`/switches${qs({ site_id: siteId })}`, ['devices'], 20_000);
  const [adding, setAdding] = useState(false);
  const selected = params.get('switch') ?? list.data?.items[0]?.id ?? null;
  const admin = can('admin');

  return (
    <>
      <PageHeader
        title={tx.title}
        description={tx.subtitle}
        actions={
          admin && site && !adding ? (
            <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" aria-hidden />
              {tx.addSwitch}
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-4">
        {adding && site && <AddSwitch site={site} onDone={(id) => (setAdding(false), list.reload(), id && router.replace(`/ports?switch=${id}`))} />}
        <Async query={list}>
          {(data) =>
            data.items.length === 0 ? (
              adding ? null : (
                <Card>
                  <EmptyState icon={<Cable className="size-8" />} title={tx.emptyTitle}>
                    <p className="mx-auto max-w-xl text-sm text-muted">{tx.emptyBody}</p>
                    {!admin && <p className="mt-2 text-xs text-faint">{tx.onlyAdmins}</p>}
                  </EmptyState>
                </Card>
              )
            ) : (
              <>
                <Finder siteId={siteId} />
                <Card title={tx.switches} padded={false}>
                  <ul className="divide-y divide-line">
                    {data.items.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => router.replace(`/ports?switch=${s.id}`)}
                          aria-current={s.id === selected}
                          className={`flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-start hover:bg-raised/60 ${s.id === selected ? 'bg-raised/60' : ''}`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium" dir="auto">
                              {s.name}
                            </span>
                            <span className="mono text-xs text-muted">{s.host}</span>
                          </span>
                          <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                            {s.last_status === 'ok' && (
                              <span className="tnum">
                                {s.ports_up}/{s.port_count} {tx.portsUp} · {s.address_count} {tx.addresses}
                              </span>
                            )}
                            <Badge tone={STATUS_TONE[s.last_status]}>{tx.status[s.last_status]}</Badge>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
                {selected && <SwitchView id={selected} admin={admin} canPoll={can('technician')} onRemoved={() => (router.replace('/ports'), list.reload())} />}
              </>
            )
          }
        </Async>
      </div>
    </>
  );
}

function Finder({ siteId }: { siteId: string | null }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const hits = useQuery<{ items: PortSearchHit[] }>(q.length >= 2 ? `/ports/find${qs({ q, site_id: siteId })}` : null, [], 0);
  return (
    <Card>
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-faint" aria-hidden />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={tx.search} aria-label={tx.search} className="ps-9" maxLength={100} />
      </div>
      {q.length >= 2 && hits.data && (
        <ul className="mt-3 divide-y divide-line">
          {hits.data.items.length === 0 && <li className="py-2 text-sm text-muted">{tx.noHits}</li>}
          {hits.data.items.map((h) => (
            <li key={h.device.id} className="py-3">
              <p className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                <Link href={`/devices/${h.device.id}`} className="font-medium hover:text-accent-hover" dir="auto">
                  {h.device.label}
                </Link>
                <StatusBadge status={h.device.status} />
                <span className="mono text-xs text-muted">{[h.device.ip, h.device.mac].filter(Boolean).join(' · ')}</span>
              </p>
              {h.location ? <LocationView loc={h.location} /> : <p className="text-xs text-muted">{h.device.mac ? tx.notLocated.not_seen : tx.notLocated.no_mac}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AddSwitch({ site, onDone }: { site: string; onDone: (id?: string) => void }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const [host, setHost] = useState('');
  const [name, setName] = useState('');
  const [version, setVersion] = useState<'2c' | '3'>('2c');
  const [community, setCommunity] = useState('');
  const [username, setUsername] = useState('');
  const [authProto, setAuthProto] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [privProto, setPrivProto] = useState('');
  const [privPass, setPrivPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const credentials =
      version === '2c'
        ? { version, community }
        : {
            version,
            username,
            ...(authProto ? { auth_protocol: authProto, auth_password: authPass } : {}),
            ...(authProto && privProto ? { priv_protocol: privProto, priv_password: privPass } : {}),
          };
    try {
      const res = await api<{ id: string }>('/switches', { method: 'POST', body: { site_id: site, host: host.trim(), ...(name.trim() ? { name: name.trim() } : {}), credentials } });
      onDone(res.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  const ready = host.trim() && (version === '2c' ? community : username && (!authProto || authPass.length >= 8) && (!privProto || privPass.length >= 8));
  const secret = { type: 'password', autoComplete: 'new-password', spellCheck: false } as const;

  return (
    <Card title={tx.addSwitch}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={tx.host} hint={tx.hostHint}>
          {(id) => <Input id={id} dir="ltr" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.2" maxLength={15} />}
        </Field>
        <Field label={tx.name}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}</Field>
        <Field label={tx.version}>
          {(id) => (
            <Select id={id} value={version} onChange={(e) => setVersion(e.target.value as '2c' | '3')}>
              <option value="2c">SNMP v2c</option>
              <option value="3">SNMP v3</option>
            </Select>
          )}
        </Field>
        {version === '2c' ? (
          <Field label={tx.community} hint={tx.communityHint}>
            {(id) => <Input id={id} dir="ltr" {...secret} value={community} onChange={(e) => setCommunity(e.target.value)} maxLength={128} />}
          </Field>
        ) : (
          <>
            <Field label={tx.username}>{(id) => <Input id={id} dir="ltr" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64} />}</Field>
            <Field label={tx.authProtocol}>
              {(id) => (
                <Select id={id} value={authProto} onChange={(e) => setAuthProto(e.target.value)}>
                  <option value="">{tx.none}</option>
                  <option value="sha256">SHA-256</option>
                  <option value="sha">SHA-1</option>
                  <option value="md5">MD5</option>
                </Select>
              )}
            </Field>
            {authProto && (
              <>
                <Field label={tx.authPassword} hint={tx.communityHint}>
                  {(id) => <Input id={id} dir="ltr" {...secret} value={authPass} onChange={(e) => setAuthPass(e.target.value)} maxLength={128} />}
                </Field>
                <Field label={tx.privProtocol}>
                  {(id) => (
                    <Select id={id} value={privProto} onChange={(e) => setPrivProto(e.target.value)}>
                      <option value="">{tx.none}</option>
                      <option value="aes">AES</option>
                      <option value="des">DES</option>
                    </Select>
                  )}
                </Field>
                {privProto && (
                  <Field label={tx.privPassword}>
                    {(id) => <Input id={id} dir="ltr" {...secret} value={privPass} onChange={(e) => setPrivPass(e.target.value)} maxLength={128} />}
                  </Field>
                )}
              </>
            )}
          </>
        )}
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" busy={busy} disabled={!ready} onClick={save}>
          {tx.save}
        </Button>
        <Button variant="ghost" onClick={() => onDone()}>
          {tx.cancel}
        </Button>
      </div>
    </Card>
  );
}

function SwitchView({ id, admin, canPoll, onRemoved }: { id: string; admin: boolean; canPoll: boolean; onRemoved: () => void }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const q = useQuery<SwitchDetail>(`/switches/${id}`, ['devices'], 20_000);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function readNow() {
    setBusy(true);
    setError(null);
    try {
      await api(`/switches/${id}/poll`, { method: 'POST' });
      setNote(tx.queued);
      setTimeout(() => setNote(null), 8000);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm(tx.removeConfirm)) return;
    await api(`/switches/${id}`, { method: 'DELETE' });
    onRemoved();
  }

  return (
    <Async query={q}>
      {(s) => (
        <Card
          padded={false}
          title={
            <span dir="auto">
              {s.name} <span className="mono text-xs font-normal text-muted">{s.host}</span>
            </span>
          }
          action={
            <span className="flex gap-1">
              {canPoll && (
                <Button size="sm" busy={busy} onClick={readNow}>
                  <RefreshCw className="size-3.5" aria-hidden />
                  {tx.readNow}
                </Button>
              )}
              {admin && (
                <Button size="sm" variant="ghost" onClick={remove} aria-label={tx.remove}>
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              )}
            </span>
          }
        >
          <div className="space-y-1 px-4 pt-3 text-xs text-muted">
            <p>
              <Badge tone={STATUS_TONE[s.last_status]}>{tx.status[s.last_status]}</Badge>{' '}
              {s.last_ok_at && (
                <span>
                  {tx.lastRead}: {relativeTime(s.last_ok_at, locale)}
                </span>
              )}
              {s.sys_descr && <span className="ms-2 text-faint" dir="auto">{s.sys_descr}</span>}
            </p>
            {s.last_status === 'error' && s.last_error && <p className="text-crit">{s.last_error}</p>}
            {!s.in_scope && <p className="text-warn">{tx.outOfScope}</p>}
            {s.truncated.length > 0 && <p className="text-warn">{tx.truncated}</p>}
            {note && <p className="text-ok">{note}</p>}
            {error && <ErrorNote error={error} />}
          </div>
          {s.ports.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[820px] text-start text-[13px]">
                <thead>
                  <tr className="border-y border-line text-xs text-muted">
                    <th scope="col" className="px-4 py-2 text-start font-medium">{tx.port}</th>
                    <th scope="col" className="px-3 py-2 text-start font-medium">{tx.state}</th>
                    <th scope="col" className="px-3 py-2 text-start font-medium">{tx.connected}</th>
                    <th scope="col" className="px-3 py-2 text-start font-medium">{tx.traffic}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{tx.errors}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {s.ports.map((p) => (
                    <PortRow key={p.if_index} p={p} switchId={s.id} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </Async>
  );
}

function speed(mbps: number): string {
  return mbps >= 1000 ? `${mbps / 1000} Gb/s` : mbps > 0 ? `${mbps} Mb/s` : '';
}

function PortRow({ p, switchId }: { p: SwitchPort; switchId: string }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const [open, setOpen] = useState(false);
  const busiest = Math.max(p.in_bps ?? 0, p.out_bps ?? 0);
  const share = p.speed_mbps > 0 && (p.in_bps !== null || p.out_bps !== null) ? (busiest / (p.speed_mbps * 1e6)) * 100 : null;
  const total = p.in_errors + p.out_errors;
  const rising = (p.errors_delta ?? 0) > 0;
  return (
    <>
    <tr className="align-top">
      <td className="px-4 py-2.5">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? tx.hideHistory : tx.showHistory} className="mono inline-flex items-center gap-1 font-medium hover:text-accent-hover">
          {p.name}
          {open ? <ChevronUp className="size-3.5 text-faint" aria-hidden /> : <ChevronDown className="size-3.5 text-faint" aria-hidden />}
        </button>
        {p.alias && <span className="block text-xs text-muted" dir="auto">{p.alias}</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5">
        <Badge tone={p.oper_up ? 'ok' : 'idle'}>{p.oper_up ? tx.up : p.admin_up ? tx.down : tx.disabled}</Badge>
        {p.oper_up && <span className="mt-0.5 block text-xs text-faint tnum">{speed(p.speed_mbps)}</span>}
      </td>
      <td className="px-3 py-2.5">
        {p.role !== 'down' && p.role !== 'edge' && (
          <span className="mb-1 block">
            <Badge tone={ROLE_TONE[p.role]} dot={false}>
              {tx.role[p.role]}
            </Badge>
          </span>
        )}
        {p.neighbors.map((n, i) => (
          <span key={i} className="block text-xs text-muted" dir="auto">
            {tx.neighbor} {n.sys_name ?? n.chassis_id ?? '?'} {n.port_id && <span className="mono">({n.port_id})</span>}
          </span>
        ))}
        {p.devices.map((d) => (
          <Link key={d.mac} href={`/devices/${d.id}`} className="block truncate hover:text-accent-hover" dir="auto">
            {d.label} <span className="mono text-xs text-muted">{d.ip ?? d.mac}</span>
            {d.vlan > 0 && <span className="text-xs text-faint"> · VLAN {d.vlan}</span>}
          </Link>
        ))}
        {(p.role === 'trunk' || p.role === 'uplink') && p.mac_count > 0 ? (
          <span className="block text-xs text-faint tnum">
            {p.mac_count} {tx.moreAddr}
          </span>
        ) : (
          p.unknown_addresses.length > 0 && (
            <span className="block text-xs text-faint" title={p.unknown_addresses.join('\n')}>
              <span className="mono">{p.unknown_addresses[0]}</span>
              {p.unknown_addresses.length > 1 && ` +${p.unknown_addresses.length - 1}`} · {tx.unknownAddr}
            </span>
          )
        )}
        {p.role === 'down' && <span className="text-xs text-faint">{tx.nothing}</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-xs">
        {p.in_bps === null && p.out_bps === null ? (
          <span className="text-faint">{p.oper_up ? tx.trafficNone : '—'}</span>
        ) : (
          <>
            <span className="block tnum" dir="ltr">
              ↓ {bps(p.in_bps)} · ↑ {bps(p.out_bps)}
            </span>
            {share !== null && (
              <span className={`block tnum ${share >= 80 ? 'text-warn' : 'text-faint'}`}>
                {share < 1 ? '<1' : Math.round(share)}% {tx.ofSpeed}
              </span>
            )}
          </>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
        {rising ? (
          <span className="text-crit tnum">
            +{p.errors_delta} {tx.newErrors} {Math.max(1, Math.round((p.delta_seconds ?? 60) / 60))} {tx.min}
          </span>
        ) : null}
        <span className="block text-faint tnum">{total > 0 ? `${total} ${tx.total}` : rising ? '' : tx.noErrors}</span>
      </td>
    </tr>
    {open && (
      <tr>
        <td colSpan={5} className="bg-bg/40 px-4 py-3">
          <PortHistoryChart switchId={switchId} ifIndex={p.if_index} />
        </td>
      </tr>
    )}
    </>
  );
}

export default function PortsPage() {
  return (
    <Suspense>
      <PortsView />
    </Suspense>
  );
}
