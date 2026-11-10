'use client';

import { MonitorSmartphone, Search, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { DEVICE_TYPES, type Device, type Paginated } from '@lan-detective/shared-types';
import { Async, Button, Card, EmptyState, Input, PageHeader, Select, StatusBadge, Tag } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL, absoluteTime, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

const PAGE_SIZE = 50;
const SORTS = ['ip', 'name', 'status', 'last_seen', 'first_seen'] as const;

function DevicesView() {
  const { t, locale } = useI18n();
  const { siteId } = useApp();
  const router = useRouter();
  const params = useSearchParams();

  // Filters live in the URL so a filtered view can be bookmarked and shared.
  const status = params.get('status') ?? '';
  const type = params.get('type') ?? '';
  const sort = params.get('sort') ?? 'ip';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1));
  const [search, setSearch] = useState(q);

  const update = (next: Record<string, string>) => {
    const merged = { status, type, sort, q, page: String(page), ...next };
    if (!('page' in next)) merged.page = '1';
    router.replace(`/devices${qs({ ...merged, sort: merged.sort === 'ip' ? '' : merged.sort, page: merged.page === '1' ? '' : merged.page })}`);
  };

  useEffect(() => {
    if (search === q) return;
    const timer = setTimeout(() => update({ q: search }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = useQuery<Paginated<Device>>(`/devices${qs({ site_id: siteId, status, device_type: type, sort, q, page, page_size: PAGE_SIZE })}`, ['devices']);
  const filtered = Boolean(status || type || q);

  return (
    <>
      <PageHeader title={t('devices.title')} description={query.data ? `${query.data.total} ${t('devices.count')}` : undefined} />
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-faint" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('devices.searchPlaceholder')} aria-label={t('common.search')} className="ps-9" maxLength={100} />
        </div>
        <Select aria-label={t('devices.status')} value={status} onChange={(e) => update({ status: e.target.value })} className="sm:w-36">
          <option value="">
            {t('devices.status')}: {t('common.all')}
          </option>
          {(['online', 'offline', 'unknown'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </Select>
        <Select aria-label={t('devices.type')} value={type} onChange={(e) => update({ type: e.target.value })} className="sm:w-44">
          <option value="">
            {t('devices.type')}: {t('common.all')}
          </option>
          {DEVICE_TYPES.map((d) => (
            <option key={d} value={d}>
              {DEVICE_TYPE_LABEL[d]?.[locale]}
            </option>
          ))}
        </Select>
        <Select aria-label={t('devices.sort')} value={sort} onChange={(e) => update({ sort: e.target.value })} className="sm:w-40">
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`devices.sort.${s}`)}
            </option>
          ))}
        </Select>
      </div>

      <Card padded={false}>
        <Async query={query}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState icon={<MonitorSmartphone className="size-8" />} title={filtered ? t('devices.empty') : t('devices.emptyNone')} />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-start text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-xs text-muted">
                        <th scope="col" className="px-4 py-2.5 text-start font-medium">{t('devices.col.device')}</th>
                        <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('devices.status')}</th>
                        <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('devices.col.ip')}</th>
                        <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('devices.col.mac')}</th>
                        <th scope="col" className="px-3 py-2.5 text-start font-medium">{t('devices.type')}</th>
                        <th scope="col" className="px-4 py-2.5 text-start font-medium">{t('devices.col.lastSeen')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.items.map((d) => (
                        <tr key={d.id} className="group hover:bg-raised/60">
                          <td className="max-w-[18rem] px-4 py-2.5">
                            <Link href={`/devices/${d.id}`} className="block font-medium text-fg group-hover:text-accent-hover" dir="auto">
                              <span className="block truncate">{d.display_name || d.hostname || d.current_ip || d.primary_mac}</span>
                            </Link>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1">
                              {d.is_critical && (
                                <span className="inline-flex items-center gap-1 text-[11px] text-warn">
                                  <ShieldAlert className="size-3" aria-hidden />
                                  {t('devices.critical')}
                                </span>
                              )}
                              {!siteId && <Tag>{d.site_name}</Tag>}
                              {d.tags.map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                              ))}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <StatusBadge status={d.status} />
                          </td>
                          <td className="mono px-3 py-2.5 text-start">{d.current_ip ?? '—'}</td>
                          <td className="px-3 py-2.5">
                            <span className="mono block text-start text-xs">{d.primary_mac ?? '—'}</span>
                            <span className="block max-w-[14rem] truncate text-xs text-muted">
                              {d.vendor ?? (d.mac_randomized ? t('devices.randomizedMac') : d.identity_basis === 'ip' ? t('devices.ipIdentity') : '')}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-muted">
                            {DEVICE_TYPE_LABEL[d.device_type]?.[locale] ?? d.device_type}
                            {d.type_source === 'inferred' && (
                              <span className="block text-[11px] text-faint">
                                {t('common.inferred')}
                                {d.type_confidence ? ` · ${t(`dx.confidence.${d.type_confidence}`)}` : ''}
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-muted" title={absoluteTime(d.last_seen_at, locale)}>
                            {relativeTime(d.last_seen_at, locale)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.total > PAGE_SIZE && (
                  <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-muted">
                    <span className="tnum">
                      {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} / {data.total}
                    </span>
                    <span className="flex gap-2">
                      <Button size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
                        {t('devices.prev')}
                      </Button>
                      <Button size="sm" disabled={page * PAGE_SIZE >= data.total} onClick={() => update({ page: String(page + 1) })}>
                        {t('devices.next')}
                      </Button>
                    </span>
                  </div>
                )}
              </>
            )
          }
        </Async>
      </Card>
    </>
  );
}

export default function DevicesPage() {
  return (
    <Suspense>
      <DevicesView />
    </Suspense>
  );
}
