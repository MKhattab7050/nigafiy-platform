'use client';

import type { IpamSubnetSummary } from '@lan-detective/shared-types';
import { Hash, Network } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Async, Badge, Card, EmptyState, PageHeader, Segmented } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { SubnetView } from '../components/subnet-view';
import { UsageBar, countText } from '../components/usage-bar';
import { SubnetCalculator } from '../components/subnet-calculator';
import { ipamText } from '../text';

export type Filter = 'all' | 'online' | 'documented' | 'conflicts';

export function IpamView() {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const { siteId, sites, can } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<'subnets' | 'calculator'>('subnets');
  const list = useQuery<{ items: IpamSubnetSummary[] }>(`/ipam/subnets${qs({ site_id: siteId })}`, ['devices'], 30_000);
  const rawSelected = params.get('subnet');
  const selected = (rawSelected && list.data?.items.some((s) => s.id === rawSelected) ? rawSelected : list.data?.items[0]?.id) ?? null;
  const current = list.data?.items.find((s) => s.id === selected);

  return (
    <>
      <PageHeader icon={<Hash className="size-[18px]" aria-hidden />}
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
                      <Link href="/radar/discovery" className="text-[13px] text-accent hover:underline">
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
                      const used = BigInt(s.usable_exact) - BigInt(s.free_exact);
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => router.replace(`/radar/ipam?subnet=${s.id}`)}
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
                                {countText(used)} {tx.of} {countText(s.usable_exact)} {tx.inUse} · {countText(s.free_exact)} {tx.free}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
                {selected && <SubnetView key={selected} id={selected} onChanged={() => list.reload()} />}
              </div>
            )
          }
        </Async>
      )}
    </>
  );
}


export function IpamScreen() {
  return (
    <Suspense>
      <IpamView />
    </Suspense>
  );
}
