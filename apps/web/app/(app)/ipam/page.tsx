'use client';

import type { IpamAddress, IpamSubnetDetail, IpamSubnetSummary } from '@lan-detective/shared-types';
import { AlertTriangle, Download, Network, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { AddressMap, AddressModal, PlanModal, STATE_TONE, SubnetCalculator, UsageBar } from '@/components/ipam';
import { Async, Badge, Button, Card, EmptyState, Fact, Input, PageHeader, Segmented } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ipamText } from '@/lib/ipam-text';
import { ipToInt } from '@/lib/subnet-calc';

type Filter = 'all' | 'online' | 'documented' | 'conflicts';

function IpamView() {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const { siteId, sites, can } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<'subnets' | 'calculator'>('subnets');
  const list = useQuery<{ items: IpamSubnetSummary[] }>(`/ipam/subnets${qs({ site_id: siteId })}`, ['devices'], 30_000);
  const selected = params.get('subnet') ?? list.data?.items[0]?.id ?? null;
  const current = list.data?.items.find((s) => s.id === selected);

  return (
    <>
      <PageHeader
        title={tx.title}
        description={tx.subtitle}
        actions={
          <Segmented
            label={tx.title}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'subnets', label: tx.tabs.subnets },
              { value: 'calculator', label: tx.tabs.calculator },
            ]}
          />
        }
      />
      {tab === 'calculator' ? (
        <SubnetCalculator initial={current?.cidr} />
      ) : (
        <Async query={list}>
          {(data) =>
            data.items.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<Network className="size-8" />}
                  title={tx.emptyTitle}
                  action={
                    can('admin') ? (
                      <Link href="/discovery" className="text-[13px] text-accent hover:underline">
                        {tx.emptyAction}
                      </Link>
                    ) : undefined
                  }
                >
                  {tx.emptyBody}
                </EmptyState>
              </Card>
            ) : (
              <div className="space-y-4">
                <Card title={tx.subnets} padded={false}>
                  <ul className="divide-y divide-line">
                    {data.items.map((s) => {
                      const used = s.usable - s.free;
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => router.replace(`/ipam?subnet=${s.id}`)}
                            aria-current={s.id === selected}
                            className={`grid w-full gap-x-4 gap-y-2 px-4 py-3 text-start hover:bg-raised/60 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center ${s.id === selected ? 'bg-raised/60' : ''}`}
                          >
                            <span className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="mono font-medium">{s.cidr}</span>
                              {s.label && (
                                <span className="truncate text-[13px] text-muted" dir="auto">
                                  {s.label}
                                </span>
                              )}
                              {sites.length > 1 && !siteId && <span className="text-xs text-faint">{s.site_name}</span>}
                              {s.vlan_id && (
                                <Badge tone="idle" dot={false}>
                                  VLAN {s.vlan_id}
                                </Badge>
                              )}
                              {!s.enabled && (
                                <Badge tone="idle" dot={false}>
                                  {tx.scanOff}
                                </Badge>
                              )}
                              {s.conflicts > 0 && (
                                <Badge tone="crit">
                                  {s.conflicts} {tx.conflictsN}
                                </Badge>
                              )}
                            </span>
                            <span className="min-w-0">
                              <UsageBar usable={s.usable} online={s.online} offline={s.offline} documented={s.documented_only} />
                              <span className="mt-1 block text-xs text-muted tnum">
                                {used} {tx.of} {s.usable} {tx.inUse} · {s.free} {tx.free}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
                {selected && <SubnetView key={selected} id={selected} />}
              </div>
            )
          }
        </Async>
      )}
    </>
  );
}

function SubnetView({ id }: { id: string }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const { can } = useApp();
  const q = useQuery<IpamSubnetDetail>(`/ipam/subnets/${id}`, ['devices'], 30_000);
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <Async query={q}>
      {(s) => (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            <Card
              title={tx.plan}
              action={
                <span className="flex gap-1">
                  <a
                    href={`/api/v1/ipam/subnets/${s.id}/export.csv`}
                    download
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent px-2.5 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-fg"
                  >
                    <Download className="size-3.5" aria-hidden />
                    {tx.exportCsv}
                  </a>
                  {can('admin') && (
                    <Button size="sm" onClick={() => setEditing(true)}>
                      <Pencil className="size-3.5" aria-hidden />
                      {tx.edit}
                    </Button>
                  )}
                </span>
              }
            >
              <dl>
                <Fact label={tx.network}>
                  <span className="mono">{s.cidr}</span>
                </Fact>
                <Fact label={tx.netmask}>
                  <span className="mono">{s.netmask}</span>
                </Fact>
                <Fact label={tx.hostRange}>
                  <span className="mono">
                    {s.first_host} – {s.last_host}
                  </span>
                </Fact>
                <Fact label={tx.broadcast}>
                  <span className="mono">{s.broadcast}</span>
                </Fact>
                <Fact label={tx.gateway} source={s.gateway ? tx.gatewaySource[s.gateway.source] : undefined}>
                  {s.gateway ? <span className="mono">{s.gateway.ip}</span> : <span className="text-muted">{tx.notSet}</span>}
                </Fact>
                <Fact label={tx.vlan}>{s.vlan_id ?? <span className="text-muted">{tx.notSet}</span>}</Fact>
                <Fact label={tx.dhcpPool} source={s.dhcp ? tx.dhcpNote : undefined}>
                  {s.dhcp ? (
                    <span className="mono">
                      {s.dhcp.start} – {s.dhcp.end}
                    </span>
                  ) : (
                    <span className="text-muted">{tx.notSet}</span>
                  )}
                </Fact>
                <Fact label={tx.dns}>{s.dns_servers.length ? <span className="mono">{s.dns_servers.join(', ')}</span> : <span className="text-muted">{tx.notSet}</span>}</Fact>
                {s.notes && (
                  <Fact label={tx.notes}>
                    <span className="whitespace-pre-wrap" dir="auto">
                      {s.notes}
                    </span>
                  </Fact>
                )}
                <Fact label={tx.lastScan}>{s.last_scan_at ? relativeTime(s.last_scan_at, locale) : <span className="text-muted">{tx.neverScanned}</span>}</Fact>
              </dl>
              {!can('admin') && <p className="mt-3 text-xs text-faint">{tx.onlyAdmins}</p>}
            </Card>

            <div className="space-y-4">
              {s.conflict_list.length > 0 && (
                <Card
                  title={
                    <span className="flex items-center gap-2">
                      <AlertTriangle className="size-4 text-crit" aria-hidden />
                      {tx.conflicts}
                    </span>
                  }
                  padded={false}
                >
                  <ul className="divide-y divide-line">
                    {s.conflict_list.map((c) => (
                      <li key={`${c.ip}-${c.kind}`} className="px-4 py-3">
                        <p className="flex flex-wrap items-center gap-2 text-[13px]">
                          <button type="button" onClick={() => setPicked(c.ip)} className="mono font-medium text-accent hover:underline">
                            {c.ip}
                          </button>
                          <span className="font-medium">{tx.conflictKind[c.kind]}</span>
                        </p>
                        <ul dir="ltr" className="mt-1 list-disc space-y-0.5 ps-5 text-start text-xs text-muted">
                          {c.evidence.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                        <p className="mt-1 text-xs text-faint">{tx.conflictHelp[c.kind]}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              <Card title={tx.map}>
                <AddressMap subnet={s} onPick={setPicked} />
                <div className="mt-4 border-t border-line pt-3 text-xs text-muted">
                  {s.next_free.length ? (
                    <p className="flex flex-wrap items-center gap-2">
                      {tx.nextFree}:
                      {s.next_free.map((ip) => (
                        <button key={ip} type="button" onClick={() => setPicked(ip)} className="mono rounded border border-line-strong bg-raised px-1.5 py-0.5 text-fg hover:border-accent">
                          {ip}
                        </button>
                      ))}
                    </p>
                  ) : (
                    <p>{tx.nextFreeNone}</p>
                  )}
                </div>
              </Card>
            </div>
          </div>

          <div className="mt-4">
            <AddressTable subnet={s} onPick={setPicked} />
          </div>

          {editing && <PlanModal subnet={s} onClose={() => setEditing(false)} onSaved={() => (setEditing(false), q.reload())} />}
          {picked && <AddressModal key={picked} subnet={s} ip={picked} onClose={() => setPicked(null)} onChanged={q.reload} />}
        </>
      )}
    </Async>
  );
}

function AddressTable({ subnet, onPick }: { subnet: IpamSubnetDetail; onPick: (ip: string) => void }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const [filter, setFilter] = useState<Filter>('all');
  const [text, setText] = useState('');
  const first = ipToInt(subnet.first_host)!;
  const last = ipToInt(subnet.last_host)!;

  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const match = (a: IpamAddress) =>
      !needle || [a.ip, a.record?.label, a.record?.mac, a.record?.notes, ...a.devices.flatMap((d) => [d.label, d.mac])].some((v) => v?.toLowerCase().includes(needle));
    return subnet.addresses.filter((a) => {
      const n = ipToInt(a.ip)!;
      if (n < first || n > last) return false;
      if (filter === 'online' && a.state !== 'online') return false;
      if (filter === 'documented' && !a.record) return false;
      if (filter === 'conflicts' && !a.conflict) return false;
      return match(a);
    });
  }, [subnet.addresses, filter, text, first, last]);

  return (
    <Card
      title={`${tx.addresses} (${rows.length})`}
      padded={false}
      action={
        <Segmented
          label={tx.addresses}
          value={filter}
          onChange={setFilter}
          options={(['all', 'online', 'documented', 'conflicts'] as const).map((f) => ({ value: f, label: tx.filter[f] }))}
        />
      }
    >
      <div className="border-b border-line p-3">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={tx.search} aria-label={tx.search} maxLength={60} className="max-w-sm" />
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">{tx.noRows}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-start text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="px-4 py-2 text-start font-medium">{tx.colAddress}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{tx.colState}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{tx.colDevice}</th>
                <th scope="col" className="px-4 py-2 text-start font-medium">{tx.colRecord}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((a) => {
                const d = a.devices[0];
                return (
                  <tr key={a.ip} className="align-top hover:bg-raised/40">
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <button type="button" onClick={() => onPick(a.ip)} className="mono font-medium hover:text-accent-hover">
                        {a.ip}
                      </button>
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {a.flags.map((f) => (
                          <span key={f} className="text-[11px] text-faint">
                            {tx.flag[f]}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <Badge tone={a.conflict ? 'crit' : STATE_TONE[a.state]}>{tx.state[a.state]}</Badge>
                      {a.conflict && <span className="mt-1 block text-xs text-crit">{tx.conflictKind[a.conflict]}</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {d ? (
                        <>
                          <Link href={`/devices/${d.id}`} className="block truncate hover:text-accent-hover" dir="auto">
                            {d.label}
                          </Link>
                          <span className="mono text-xs text-muted">{d.mac ?? ''}</span>
                          {a.devices.length > 1 && <span className="text-xs text-faint"> +{a.devices.length - 1}</span>}
                        </>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {a.record ? (
                        <>
                          <span className="block" dir="auto">
                            {a.record.label}
                          </span>
                          <span className="text-xs text-muted">
                            {tx.kind[a.record.kind]}
                            {a.record.mac && <span className="mono"> · {a.record.mac}</span>}
                          </span>
                        </>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function IpamPage() {
  return (
    <Suspense>
      <IpamView />
    </Suspense>
  );
}
