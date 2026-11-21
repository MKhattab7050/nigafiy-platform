'use client';

import type { SwitchSummary } from '@lan-detective/shared-types';
import { Cable, Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { EmptyPortsArt } from '@/components/illustrations';
import { Async, Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { STATUS_TONE } from '../components/port-tones';
import { Finder } from '../components/finder';
import { AddSwitch } from '../components/add-switch';
import { SitePortControlCard } from '../components/site-port-control';
import { SwitchView } from '../components/switch-view';
import { portsText } from '../text';

export function PortsView() {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const { siteId, sites, can } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const site = siteId ?? sites[0]?.id ?? null;
  const list = useQuery<{ items: SwitchSummary[] }>(`/switches${qs({ site_id: siteId })}`, ['devices'], 20_000);
  const [adding, setAdding] = useState(false);
  const rawSelected = params.get('switch');
  const selected = (rawSelected && list.data?.items.some((s) => s.id === rawSelected) ? rawSelected : list.data?.items[0]?.id) ?? null;
  const admin = can('admin');
  // Port-control settings are per site: shown for the selected site (or the only one).
  const settingsSite = siteId ?? (sites.length === 1 ? sites[0]!.id : null);

  return (
    <>
      <PageHeader
        icon={<Cable className="size-[18px]" />}
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
        {adding && site && <AddSwitch siteId={siteId} sites={sites} onDone={(id) => (setAdding(false), list.reload(), id && router.replace(`/ports?switch=${id}`))} />}
        <Async query={list}>
          {(data) =>
            data.items.length === 0 ? (
              adding ? null : (
                <Card>
                  <EmptyState illustration={<EmptyPortsArt />} title={tx.emptyTitle}>
                    <p className="mx-auto max-w-xl">{tx.emptyBody}</p>
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
                {settingsSite && <SitePortControlCard siteId={settingsSite} admin={admin} />}
                {selected && <SwitchView id={selected} admin={admin} canPoll={can('technician')} onRemoved={() => (router.replace('/ports'), list.reload())} onUpdated={() => list.reload()} />}
              </>
            )
          }
        </Async>
      </div>
    </>
  );
}


export function PortsScreen() {
  return (
    <Suspense>
      <PortsView />
    </Suspense>
  );
}
