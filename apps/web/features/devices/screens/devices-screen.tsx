'use client';

import { BellOff, CheckCheck, MonitorSmartphone, Search, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { DEVICE_TRUSTS, DEVICE_TYPES, type Device, type Paginated } from '@lan-detective/shared-types';
import { DeviceIcon } from '@/components/device-icon';
import { EmptyPortsArt, SearchArt } from '@/components/illustrations';
import { Async, Badge, Button, Card, DataTable, EmptyState, ErrorNote, Input, PageHeader, Select, SkeletonBlock, StatusBadge, Tag } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL, absoluteTime, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export const PAGE_SIZE = 50;
export const SORTS = ['ip', 'name', 'status', 'last_seen', 'first_seen'] as const;

export function DevicesView() {
  const { t, locale } = useI18n();
  const { siteId } = useApp();
  const router = useRouter();
  const params = useSearchParams();

  // Filters live in the URL so a filtered view can be bookmarked and shared.
  const status = params.get('status') ?? '';
  const type = params.get('type') ?? '';
  const trust = params.get('trust') ?? '';
  const sort = params.get('sort') ?? 'ip';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1));
  const [search, setSearch] = useState(q);

  const update = useCallback(
    (next: Record<string, string>) => {
      const merged = { status, type, trust, sort, q, page: String(page), ...next };
      if (!('page' in next)) merged.page = '1';
      router.replace(`/devices${qs({ ...merged, sort: merged.sort === 'ip' ? '' : merged.sort, page: merged.page === '1' ? '' : merged.page })}`);
    },
    [status, type, trust, sort, q, page, router],
  );

  useEffect(() => {
    setSearch(q);
  }, [q]);

  useEffect(() => {
    if (search === q) return;
    const timer = setTimeout(() => update({ q: search }), 300);
    return () => clearTimeout(timer);
  }, [search, q, update]);

  const query = useQuery<Paginated<Device>>(`/devices${qs({ site_id: siteId, status, device_type: type, trust, sort, q, page, page_size: PAGE_SIZE })}`, ['devices']);
  const filtered = Boolean(status || type || trust || q);
  const { can } = useApp();
  const [marking, setMarking] = useState(false);
  const [marked, setMarked] = useState<number | null>(null);
  const [markError, setMarkError] = useState<ApiError | null>(null);

  useEffect(() => {
    setMarked(null);
    setMarkError(null);
  }, [siteId]);

  async function markAllKnown() {
    if (!window.confirm(t('devices.markAllConfirm'))) return;
    setMarking(true);
    setMarkError(null);
    try {
      const res = await api<{ updated: number }>('/devices/trust', {
        method: 'POST',
        body: { all_unreviewed: true, trust: 'known', site_id: siteId ?? undefined },
      });
      setMarked(res.updated);
      query.reload();
    } catch (err) {
      setMarkError(err as ApiError);
    } finally {
      setMarking(false);
    }
  }

  return (
    <>
      <PageHeader
        icon={<MonitorSmartphone className="size-[18px]" />}
        title={t('devices.title')}
        description={query.data ? `${query.data.total} ${t('devices.count')}${marked !== null ? ` · ${marked} ${t('devices.markedKnown')}` : ''}` : undefined}
        actions={
          can('technician') && trust === 'unreviewed' && query.data && query.data.total > 0 ? (
            <Button variant="primary" size="sm" busy={marking} onClick={markAllKnown}>
              <CheckCheck className="size-3.5" aria-hidden />
              {t('devices.markAllKnown')}
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,1fr)_auto_auto_auto_auto]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('devices.searchPlaceholder')} aria-label={t('common.search')} className="ps-9" maxLength={100} />
        </div>
        <Select aria-label={t('devices.status')} value={status} onChange={(e) => update({ status: e.target.value })} className="lg:w-36">
          <option value="">
            {t('devices.status')}: {t('common.all')}
          </option>
          {(['online', 'offline', 'unknown'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </Select>
        <Select aria-label={t('devices.type')} value={type} onChange={(e) => update({ type: e.target.value })} className="lg:w-44">
          <option value="">
            {t('devices.type')}: {t('common.all')}
          </option>
          {DEVICE_TYPES.map((d) => (
            <option key={d} value={d}>
              {DEVICE_TYPE_LABEL[d]?.[locale]}
            </option>
          ))}
        </Select>
        <Select aria-label={t('devices.trust')} value={trust} onChange={(e) => update({ trust: e.target.value })} className="lg:w-40">
          <option value="">
            {t('devices.trust')}: {t('common.all')}
          </option>
          {DEVICE_TRUSTS.map((s) => (
            <option key={s} value={s}>
              {t(`trust.${s}`)}
            </option>
          ))}
        </Select>
        <Select aria-label={t('devices.sort')} value={sort} onChange={(e) => update({ sort: e.target.value })} className="lg:w-40">
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`devices.sort.${s}`)}
            </option>
          ))}
        </Select>
      </div>

      <Card padded={false}>
        {markError && (
          <div className="border-b border-line p-3">
            <ErrorNote error={markError} />
          </div>
        )}
        <Async query={query} skeleton={<div className="p-4"><SkeletonBlock lines={6} /></div>}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState illustration={filtered ? <SearchArt /> : <EmptyPortsArt />} title={filtered ? t('devices.empty') : t('devices.emptyNone')} />
            ) : (
              <>
                <DataTable stack>
                  <thead>
                    <tr>
                      <th scope="col">{t('devices.col.device')}</th>
                      <th scope="col">{t('devices.status')}</th>
                      <th scope="col">{t('devices.col.ip')}</th>
                      <th scope="col">{t('devices.col.mac')}</th>
                      <th scope="col">{t('devices.type')}</th>
                      <th scope="col">{t('devices.col.lastSeen')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((d) => (
                      <tr key={d.id} className="group">
                        <td className="max-w-[20rem]">
                          <div className="flex items-start gap-3">
                            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-line bg-sunken text-muted" title={DEVICE_TYPE_LABEL[d.device_type]?.[locale]}>
                              <DeviceIcon type={d.device_type} />
                            </span>
                            <div className="min-w-0">
                              <Link href={`/devices/${d.id}`} className="block font-medium text-fg group-hover:text-accent-hover" dir="auto">
                                <span className="block truncate">{d.display_name || d.hostname || d.current_ip || d.primary_mac}</span>
                              </Link>
                              <span className="mt-1 flex flex-wrap items-center gap-1">
                                {d.trust !== 'known' && <Badge tone={d.trust === 'unwanted' ? 'crit' : 'warn'}>{t(`trust.${d.trust}`)}</Badge>}
                                {d.alerts_muted && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-faint" title={t('devices.muted')}>
                                    <BellOff className="size-3" aria-hidden />
                                    <span className="sr-only">{t('devices.muted')}</span>
                                  </span>
                                )}
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
                            </div>
                          </div>
                        </td>
                        <td data-label={t('devices.status')}>
                          <StatusBadge status={d.status} />
                        </td>
                        <td data-label={t('devices.col.ip')} className="text-start">
                          <span className="mono">{d.current_ip ?? '—'}</span>
                        </td>
                        <td data-label={t('devices.col.mac')}>
                          <div className="min-w-0">
                            <span className="mono block text-start text-xs">{d.primary_mac ?? '—'}</span>
                            <span className="block max-w-[14rem] truncate text-xs text-muted">
                              {d.vendor ?? (d.mac_randomized ? t('devices.randomizedMac') : d.identity_basis === 'ip' ? t('devices.ipIdentity') : '')}
                            </span>
                          </div>
                        </td>
                        <td data-label={t('devices.type')} className="text-muted">
                          <div className="min-w-0">
                            <span>{DEVICE_TYPE_LABEL[d.device_type]?.[locale] ?? d.device_type}</span>
                            {d.type_source === 'inferred' && (
                              <span className="block text-[11px] text-faint">
                                {t('common.inferred')}
                                {d.type_confidence ? ` · ${t('dx.confidence')}: ${t(`dx.confidence.${d.type_confidence}`)}` : ''}
                              </span>
                            )}
                          </div>
                        </td>
                        <td data-label={t('devices.col.lastSeen')} className="whitespace-nowrap text-muted" title={absoluteTime(d.last_seen_at, locale)}>
                          <span>{relativeTime(d.last_seen_at, locale)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
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

export function DevicesScreen() {
  return (
    <Suspense>
      <DevicesView />
    </Suspense>
  );
}
