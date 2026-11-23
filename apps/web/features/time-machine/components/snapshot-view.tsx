'use client';

import { History } from 'lucide-react';
import { useState } from 'react';
import type { Snapshot, SnapshotDevice } from '@nigafiy/shared-types';
import { Async, Button, Card, EmptyState, Field, Input, StateBadge, StatusBadge } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL, absoluteTime, fromLocalInput, ms, pct, toLocalInput } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { IncidentRow } from '@/features/incidents';
import { EventList } from '@/features/events';
import { MIN, minuteNow } from './time';
import { DeviceLink } from '@/components/device-link';

export function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="tnum mt-1.5 text-2xl font-semibold leading-none">{value}</p>
    </div>
  );
}

export function DeviceTable({ devices, showStatus }: { devices: SnapshotDevice[]; showStatus: boolean }) {
  const { t, locale } = useI18n();
  return (
    <div className="max-h-[26rem] overflow-auto">
      <table className="w-full min-w-[520px] text-[13px]">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-line text-xs text-muted">
            <th scope="col" className="px-4 py-2 text-start font-medium">{t('devices.col.device')}</th>
            {showStatus && <th scope="col" className="px-3 py-2 text-start font-medium">{t('tm.statusThen')}</th>}
            <th scope="col" className="px-3 py-2 text-start font-medium">{t('tm.ipThen')}</th>
            <th scope="col" className="px-3 py-2 text-start font-medium">MAC</th>
            <th scope="col" className="px-4 py-2 text-start font-medium">{t('devices.type')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {devices.map((d) => (
            <tr key={d.id}>
              <td className="max-w-[16rem] truncate px-4 py-2" dir="auto">
                <DeviceLink id={d.id} className="hover:text-accent-hover">{d.name}</DeviceLink>
              </td>
              {showStatus && (
                <td className="px-3 py-2">
                  <StatusBadge status={d.status} />
                </td>
              )}
              <td className="mono px-3 py-2 text-start">{d.ip ?? '—'}</td>
              <td className="mono px-3 py-2 text-start text-xs">{d.mac ?? '—'}</td>
              <td className="px-4 py-2 text-muted">{DEVICE_TYPE_LABEL[d.device_type]?.[locale] ?? d.device_type}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SnapshotView() {
  const { t, locale } = useI18n();
  const { siteId } = useApp();
  const [at, setAt] = useState(() => new Date(minuteNow().getTime() - 60 * MIN));
  const shift = (minutes: number) => setAt((prev) => new Date(Math.min(minuteNow().getTime(), prev.getTime() + minutes * MIN)));
  const query = useQuery<Snapshot>(`/time-machine/snapshot${qs({ at: at.toISOString(), site_id: siteId })}`, [], 600_000);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('tm.at')}>
            {(id) => (
              <Input
                id={id}
                type="datetime-local"
                dir="ltr"
                className="w-56"
                value={toLocalInput(at)}
                max={toLocalInput(new Date())}
                onChange={(e) => {
                  const iso = fromLocalInput(e.target.value);
                  if (iso) setAt(new Date(Math.min(Date.now(), new Date(iso).getTime())));
                }}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-1.5" dir="ltr">
            {[-1440, -60, -5, 5, 60, 1440].map((m) => (
              <Button key={m} size="sm" onClick={() => shift(m)} disabled={m > 0 && at.getTime() + m * MIN > Date.now()}>
                {m > 0 ? '+' : '−'}
                {Math.abs(m) >= 1440 ? `${Math.abs(m) / 1440}d` : Math.abs(m) >= 60 ? `${Math.abs(m) / 60}h` : `${Math.abs(m)}m`}
              </Button>
            ))}
          </div>
          <p className="ms-auto text-xs text-muted">{absoluteTime(at.toISOString(), locale)}</p>
        </div>
      </Card>
      <Async query={query}>
        {(s) => (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label={t('overview.devices')} value={s.devices.total} />
              <Stat label={t('status.online')} value={s.devices.online} />
              <Stat label={t('status.offline')} value={s.devices.offline} />
              <Stat label={t('status.unknown')} value={s.devices.unknown} />
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card title={t('tm.checks')} padded={false}>
                {s.checks.length === 0 ? (
                  <EmptyState title={t('common.noData')} />
                ) : (
                  <ul className="divide-y divide-line">
                    {s.checks.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                        <span className="min-w-0 text-[13px]" dir="auto">{c.name}</span>
                        <span className="flex items-center gap-3">
                          <span className="tnum text-xs text-muted">
                            {c.samples ? `${ms(c.latency_ms)}${c.loss_pct !== null ? ` · ${pct(c.loss_pct)}` : ''}` : t('common.noData')}
                          </span>
                          <StateBadge state={c.state} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title={t('tm.incidents')} padded={false}>
                {s.incidents.length === 0 ? (
                  <EmptyState title={t('tm.noIncidents')} />
                ) : (
                  <ul className="divide-y divide-line">
                    {s.incidents.map((i) => (
                      <li key={i.id}>
                        <IncidentRow incident={i} showSite={!siteId} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card title={t('tm.devices')} padded={false}>
              {s.devices.items.length ? <DeviceTable devices={s.devices.items} showStatus /> : <EmptyState icon={<History className="size-8" />} title={t('tm.noDevices')} />}
            </Card>
            <Card title={t('tm.events')} padded={false}>
              {s.events.length ? <EventList events={s.events} showSite={!siteId} /> : <EmptyState title={t('events.empty')} />}
            </Card>
            <Card title={t('tm.method')}>
              <ul className="list-disc space-y-1 ps-5 text-xs leading-relaxed text-muted" dir="auto">
                {s.method.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}
