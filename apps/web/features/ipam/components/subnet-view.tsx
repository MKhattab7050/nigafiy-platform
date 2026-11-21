'use client';

import type { IpamSubnetDetail } from '@lan-detective/shared-types';
import { AlertTriangle, Download, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Async, Button, Card, Fact } from '@/components/ui';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { localizeIpamEvidence } from '@/lib/localize';
import { AddressTable } from './address-table';
import { PlanModal } from './plan-modal';
import { AddressModal } from './address-modal';
import { AddressMap } from './address-map';
import { ipamText } from '../text';

export function SubnetView({ id, onChanged }: { id: string; onChanged?: () => void }) {
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
                        <ul dir="auto" className="mt-1 list-disc space-y-0.5 ps-5 text-start text-xs text-muted">
                          {c.evidence.map((e) => (
                            <li key={e}>{localizeIpamEvidence(e, locale)}</li>
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

          {editing && <PlanModal subnet={s} onClose={() => setEditing(false)} onSaved={() => (setEditing(false), q.reload(), onChanged?.())} />}
          {picked && <AddressModal key={picked} subnet={s} ip={picked} onClose={() => setPicked(null)} onChanged={() => (q.reload(), onChanged?.())} />}
        </>
      )}
    </Async>
  );
}
