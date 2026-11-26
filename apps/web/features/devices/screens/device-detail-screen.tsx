'use client';

import { ArrowLeft, BellOff } from 'lucide-react';
import Link from 'next/link';
import type { DeviceDetail } from '@nigafiy/shared-types';
import { Async, Badge, Card, EmptyState, Fact, PageHeader, StatusBadge, Tag, ConfidenceBadge } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL, absoluteTime, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';
// Direct import, not the barrel: the barrel would pull the whole Fleet Pro UI onto every device page.
import { DeviceEndpointCard } from '@/features/endpoints/components/device-endpoint-card';
import { DevicePortCard } from '@/features/ports';
import { DeviceBackupCard } from '@/features/config-backup';
import { DeviceAccessCard } from '@/features/access';
import { DeviceImpactCard } from '@/features/impact';
import { KnowledgeSuggestions } from '@/features/knowledge';
import { EventList } from '@/features/events';
import { FeatureBoundary } from '@/components/error-boundary';
import { DeviceIcon } from '@/components/device-icon';
import { AvailabilityStrip, weekAvailability } from '../components/availability-strip';
import { Identification } from '../components/identification';
import { ManagePanel } from '../components/manage-panel';
import { ControlsPanel } from '../components/controls-panel';
import { DEVICE_SECTION, DeviceActions } from '../components/device-actions';

export function DeviceDetailScreen({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const query = useQuery<DeviceDetail>(`/devices/${id}`, ['devices', 'events']);

  return (
    <>
      <Link href="/radar/devices" className="mb-4 inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted hover:text-fg">
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {t('device.back')}
      </Link>
      <Async query={query}>
        {(d) => {
          const typeLabel = DEVICE_TYPE_LABEL[d.device_type]?.[locale] ?? d.device_type;
          const week = weekAvailability(d);
          return (
            <>
              <PageHeader
                icon={<DeviceIcon type={d.device_type} className="size-[18px]" />}
                title={d.display_name || d.hostname || d.current_ip || d.primary_mac || '—'}
                description={`${d.site_name} · ${typeLabel}`}
                actions={
                  <>
                    {d.tags.map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                    {d.alerts_muted && <BellOff className="size-4 text-faint" aria-label={t('devices.muted')} />}
                    {d.trust !== 'known' && <Badge tone={d.trust === 'unwanted' ? 'crit' : 'warn'}>{t(`trust.${d.trust}`)}</Badge>}
                    <StatusBadge status={d.status} />
                  </>
                }
              />
              {/* Summary strip: the facts an administrator looks for first, each with its own label. */}
              <dl className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line shadow-[var(--shadow-card)] sm:grid-cols-3 xl:grid-cols-5 [&>div]:min-w-0 [&>div]:bg-surface [&>div]:px-4 [&>div]:py-3">
                <div>
                  <dt className="text-[11.5px] text-muted">{t('device.ip')}</dt>
                  <dd className="mono mt-1 truncate text-[14px] font-medium">{d.current_ip ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-[11.5px] text-muted">{t('device.mac')}</dt>
                  <dd className="mono mt-1 truncate text-[14px] font-medium">{d.primary_mac ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-[11.5px] text-muted">{t('device.vendor')}</dt>
                  <dd className="mt-1 truncate text-[14px] font-medium" dir="auto">
                    {d.vendor ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11.5px] text-muted">{t('device.lastSeen')}</dt>
                  <dd className="mt-1 truncate text-[14px] font-medium" title={absoluteTime(d.last_seen_at, locale)}>
                    {relativeTime(d.last_seen_at, locale)}
                  </dd>
                </div>
                <div className="col-span-2 xl:col-span-1">
                  <dt className="text-[11.5px] text-muted">{t('device.availability')}</dt>
                  <dd className="tnum mt-1 text-[14px] font-medium">{week === null ? '—' : `${week.toFixed(2)}%`}</dd>
                </div>
              </dl>
              <DeviceActions device={d} />
              {d.status === 'unknown' && <p className="mb-4 rounded-[var(--radius-control)] border border-line-strong bg-raised px-3 py-2 text-[13px] text-muted">{t('device.statusUnknownHint')}</p>}
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                <div className="min-w-0 space-y-5">
                  <Card title={t('device.identity')}>
                    <dl>
                      <Fact label={t('device.ip')} source={`${t('common.observed')} · ${d.discovery_sources.join(', ')}`}>
                        <span className="mono">{d.current_ip ?? '—'}</span>
                      </Fact>
                      <Fact label={t('device.mac')} source={d.primary_mac ? (d.mac_randomized ? t('devices.randomizedMac') : `${t('common.observed')} · arp_cache`) : undefined}>
                        <span className="mono">{d.primary_mac ?? '—'}</span>
                      </Fact>
                      <Fact label={t('device.identityBasis')}>{t(d.identity_basis === 'mac' ? 'device.identity.mac' : 'device.identity.ip')}</Fact>
                      <Fact label={t('device.vendor')} source={d.vendor ? t('device.vendorSource') : undefined}>
                        {d.vendor ?? <span className="text-muted">{d.mac_randomized ? t('device.vendorNone') : '—'}</span>}
                      </Fact>
                      <Fact label={t('device.hostname')} source={d.hostname ? t(`device.nameSource.${d.name_source ?? 'rdns'}` as Key) : undefined}>
                        {d.hostname ? <span className="mono">{d.hostname}</span> : '—'}
                      </Fact>
                      <Fact
                        label={t('device.type')}
                        source={d.type_source === 'inferred' ? `${t('common.inferred')} — ${d.type_evidence ?? ''}` : d.type_source === 'manual' ? t('common.manual') : undefined}
                      >
                        {d.type_source === 'none' ? <span className="text-muted">{t('device.typeUnclassified')}</span> : typeLabel}
                      </Fact>
                      <Fact label={t('device.firstSeen')}>
                        <span title={absoluteTime(d.first_seen_at, locale)}>{absoluteTime(d.first_seen_at, locale)}</span>
                      </Fact>
                      <Fact label={t('device.lastSeen')}>
                        {relativeTime(d.last_seen_at, locale)} <span className="text-muted">· {absoluteTime(d.last_seen_at, locale)}</span>
                      </Fact>
                    </dl>
                  </Card>
                  <div id={DEVICE_SECTION.identification} className="scroll-mt-20 rounded-[var(--radius-card)]">
                  <Card title={t('device.identification')} action={d.type_source === 'inferred' && d.type_confidence ? <ConfidenceBadge confidence={d.type_confidence} /> : undefined}>
                    <Identification device={d} typeLabel={typeLabel} />
                  </Card>
                  </div>
                  <Card title={t('device.availability')}>
                    <AvailabilityStrip device={d} />
                  </Card>
                  <div id={DEVICE_SECTION.events} className="scroll-mt-20 rounded-[var(--radius-card)]">
                  <Card title={t('device.events')} padded={false}>
                    {d.recent_events.length ? <EventList events={d.recent_events} showSite={false} linkDevice={false} /> : <EmptyState title={t('device.noEvents')} />}
                  </Card>
                  </div>
                </div>
                <div className="min-w-0 space-y-5">
                  <div id={DEVICE_SECTION.endpoint} className="scroll-mt-20 rounded-[var(--radius-card)] empty:hidden">
                    <FeatureBoundary>
                      <DeviceEndpointCard device={d} />
                    </FeatureBoundary>
                  </div>
                  <div id={DEVICE_SECTION.port} className="scroll-mt-20 rounded-[var(--radius-card)] empty:hidden">
                    <FeatureBoundary>
                      <DevicePortCard deviceId={d.id} />
                    </FeatureBoundary>
                  </div>
                  <div id={DEVICE_SECTION.backup} className="scroll-mt-20 rounded-[var(--radius-card)] empty:hidden">
                    <FeatureBoundary>
                      <DeviceBackupCard deviceId={d.id} siteId={d.site_id} />
                    </FeatureBoundary>
                  </div>
                  <div id={DEVICE_SECTION.access} className="scroll-mt-20 rounded-[var(--radius-card)]">
                    <FeatureBoundary>
                      <DeviceAccessCard deviceId={d.id} siteId={d.site_id} />
                    </FeatureBoundary>
                  </div>
                  <div id={DEVICE_SECTION.impact} className="scroll-mt-20 rounded-[var(--radius-card)]">
                    <FeatureBoundary>
                      <DeviceImpactCard deviceId={d.id} siteId={d.site_id} />
                    </FeatureBoundary>
                  </div>
                  <div id={DEVICE_SECTION.knowledge} className="scroll-mt-20 rounded-[var(--radius-card)]">
                    <FeatureBoundary>
                      <KnowledgeSuggestions deviceId={d.id} />
                    </FeatureBoundary>
                  </div>
                  <Card title={t('ctl.title')}>
                    <ControlsPanel device={d} onChanged={query.reload} />
                  </Card>
                  <Card title={t('device.manage')}>
                    <ManagePanel device={d} onSaved={query.reload} />
                  </Card>
                  <Card title={t('device.addresses')} padded={false}>
                    <p className="px-4 pt-3 text-xs leading-relaxed text-muted">{t('device.addresses.hint')}</p>
                    <table className="w-full text-[13px]">
                      <tbody className="divide-y divide-line">
                        {d.addresses.map((a) => (
                          <tr key={a.ip}>
                            <td className="px-4 py-2 text-start align-top">
                              <span className="mono break-all">{a.ip}</span>
                              <span className="mt-0.5 block text-xs text-muted">
                                {t(`device.addresses.scope.${a.address_scope}` as Key)}
                                {a.current && <span className="ms-1.5 text-accent-hover">· {t('device.addresses.current')}</span>}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-end align-top text-xs text-muted">
                              <span className="block" title={`${absoluteTime(a.first_seen_at, locale)} → ${absoluteTime(a.last_seen_at, locale)}`}>
                                {relativeTime(a.first_seen_at, locale)} → {relativeTime(a.last_seen_at, locale)}
                              </span>
                              {a.sources.length > 0 && (
                                <span className="block">
                                  {t('device.addresses.observedVia')}: <span className="mono">{a.sources.join(', ')}</span>
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                  <Card title={t('device.ipHistory')} padded={false}>
                    <table className="w-full text-[13px]">
                      <tbody className="divide-y divide-line">
                        {d.ip_history.map((h) => (
                          <tr key={h.ip}>
                            <td className="mono px-4 py-2 text-start">{h.ip}</td>
                            <td className="px-4 py-2 text-end text-xs text-muted" title={`${absoluteTime(h.first_seen_at, locale)} → ${absoluteTime(h.last_seen_at, locale)}`}>
                              {relativeTime(h.first_seen_at, locale)} → {relativeTime(h.last_seen_at, locale)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}
