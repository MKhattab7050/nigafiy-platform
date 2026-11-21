'use client';

import { MonitorSmartphone } from 'lucide-react';
import type { Device, Overview, Paginated } from '@lan-detective/shared-types';
import { BarList, Donut, Legend } from '@/components/charts';
import { DeviceIcon } from '@/components/device-icon';
import { SetupArt } from '@/components/illustrations';
import { Async, SectionLabel, StatusBadge } from '@/components/ui';
import { Metric, NextStep, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useReportAttention } from '@/lib/attention';
import { DEVICE_TYPE_LABEL } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { DeviceLink } from '@/components/device-link';

/** The device list holds at most this many per request; the type breakdown is only drawn when it covers every device. */
const TYPE_SAMPLE = 200;

/**
 * Dashboard: device inventory at a glance. Counts come from GET /overview; the review queue and
 * unwanted devices from GET /devices (page_size=1, only the total is read); the type breakdown from
 * GET /devices?page_size=200, shown only when that page holds every device.
 */
export default function DevicesWidget() {
  const { t, locale } = useI18n();
  const { siteId } = useApp();
  const overview = useQuery<Overview>(`/overview${qs({ site_id: siteId })}`, ['events', 'devices', 'checks', 'collectors']);
  const unreviewed = useQuery<Paginated<Device>>(`/devices${qs({ site_id: siteId, trust: 'unreviewed', page_size: 1 })}`, ['devices']);
  const unwanted = useQuery<Paginated<Device>>(`/devices${qs({ site_id: siteId, trust: 'unwanted', status: 'online', page_size: 1 })}`, ['devices']);
  const all = useQuery<Paginated<Device>>(`/devices${qs({ site_id: siteId, page_size: TYPE_SAMPLE })}`, ['devices'], 60_000);

  useReportAttention(
    'devices',
    attentionFrom([unreviewed, unwanted], (rev, bad) => [
      ...(bad.total > 0
        ? [{ id: 'devices-unwanted', tone: 'crit' as const, text: fill(t('devices.attn.unwanted'), { count: bad.total }), action: { label: t('devices.attn.unwantedAction'), href: '/radar/devices?trust=unwanted&status=online' } }]
        : []),
      ...(rev.total > 0
        ? [{ id: 'devices-unreviewed', tone: 'warn' as const, text: fill(t('devices.attn.unreviewed'), { count: rev.total }), action: { label: t('devices.attn.review'), href: '/radar/devices?trust=unreviewed' } }]
        : []),
    ]),
  );

  const types = all.data && all.data.total <= all.data.items.length ? all.data.items : null;
  const typeCounts = types ? Object.entries(types.reduce<Record<string, number>>((m, d) => ({ ...m, [d.device_type]: (m[d.device_type] ?? 0) + 1 }), {})) : [];

  return (
    <Widget title={t('nav.devices')} icon={MonitorSmartphone} href="/radar/devices">
      <Async query={overview}>
        {(o) => {
          if (o.devices.total === 0) return <NextStep art={<SetupArt className="h-16 w-28" />} text={t('devices.emptyNone')} label={t('overview.setupCta')} href="/radar/discovery" />;
          const total = o.devices.total;
          const slices = [
            { key: 'online', label: t('status.online'), value: o.devices.online, color: 'var(--color-ok)' },
            { key: 'offline', label: t('status.offline'), value: o.devices.offline, color: 'var(--color-crit)' },
            { key: 'unknown', label: t('status.unknown'), value: o.devices.unknown, color: 'var(--color-idle)' },
          ];
          return (
            <div className="space-y-5">
              <div className="flex items-center gap-5">
                <Donut slices={slices} size={104} label={`${t('nav.devices')}: ${slices.map((s) => `${s.label} ${s.value}`).join(', ')}`}>
                  <span className="tnum text-xl font-semibold leading-none">{total}</span>
                  <span className="mt-1 text-[10.5px] text-faint">{t('overview.devices')}</span>
                </Donut>
                <div className="min-w-0 flex-1">
                  <Legend slices={slices} hrefFor={(s) => `/radar/devices?status=${s.key}`} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 border-t border-line pt-3">
                <Metric label={t('overview.new24h')} value={o.devices.new_24h} href="/radar/devices?sort=first_seen" />
                <Metric label={t('devices.widget.unreviewed')} value={unreviewed.data?.total ?? '—'} tone={unreviewed.data?.total ? 'warn' : 'idle'} href="/radar/devices?trust=unreviewed" />
              </div>
              {typeCounts.length > 0 && (
                <div>
                  <SectionLabel>{t('dash.byType')}</SectionLabel>
                  <BarList
                    label={t('dash.byType')}
                    max={5}
                    otherLabel={t('chart.other')}
                    items={typeCounts.map(([type, n]) => ({
                      key: type,
                      value: n,
                      href: `/radar/devices?type=${type}`,
                      label: (
                        <span className="inline-flex items-center gap-1.5">
                          <DeviceIcon type={type} className="size-3.5 text-faint" />
                          {DEVICE_TYPE_LABEL[type]?.[locale] ?? type}
                        </span>
                      ),
                    }))}
                  />
                </div>
              )}
              <div>
                <SectionLabel>{t('overview.problemDevices')}</SectionLabel>
                {o.problem_devices.length === 0 ? (
                  <p className="text-xs text-muted">{t('overview.noProblemDevices')}</p>
                ) : (
                  <ul className="divide-y divide-line rounded-[8px] border border-line">
                    {o.problem_devices.slice(0, 4).map((d) => (
                      <li key={d.id}>
                        <DeviceLink id={d.id} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-raised/60">
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] text-fg" dir="auto">
                              {d.name}
                            </span>
                            <span className="tnum text-[11px] text-muted">
                              {d.offline_events_7d} {t('overview.offlineTimes')}
                            </span>
                          </span>
                          <StatusBadge status={d.status} />
                        </DeviceLink>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        }}
      </Async>
    </Widget>
  );
}
