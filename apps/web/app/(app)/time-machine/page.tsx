'use client';

import { History } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Comparison, PeriodStats, Snapshot, SnapshotDevice } from '@lan-detective/shared-types';
import { EventList } from '@/components/event-list';
import { IncidentRow } from '@/components/incident-row';
import { Async, Button, Card, EmptyState, Field, Input, PageHeader, Segmented, StateBadge, StatusBadge } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL, EVENT_TYPE_LABEL, absoluteTime, fromLocalInput, ms, pct, toLocalInput } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';

const MIN = 60_000;
const minuteNow = () => new Date(Math.floor(Date.now() / MIN) * MIN);

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="tnum mt-1.5 text-2xl font-semibold leading-none">{value}</p>
    </div>
  );
}

function DeviceTable({ devices, showStatus }: { devices: SnapshotDevice[]; showStatus: boolean }) {
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
                <a href={`/devices/${d.id}`} className="hover:text-accent-hover">{d.name}</a>
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

function SnapshotView() {
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

type Preset = 'hour' | 'day' | 'week' | 'custom';
const SPAN: Record<Exclude<Preset, 'custom'>, number> = { hour: 60 * MIN, day: 1440 * MIN, week: 7 * 1440 * MIN };

function Delta({ a, b, unit, lowerIsBetter, digits = 0 }: { a: number | null; b: number | null; unit: string; lowerIsBetter: boolean; digits?: number }) {
  if (a === null || b === null) return <span className="text-faint">—</span>;
  const d = b - a;
  if (Math.abs(d) < 10 ** -digits / 2) return <span className="text-muted">0{unit}</span>;
  const better = lowerIsBetter ? d < 0 : d > 0;
  return (
    <span className={better ? 'text-ok' : 'text-crit'}>
      {d > 0 ? '+' : '−'}
      {Math.abs(d).toFixed(digits)}
      {unit}
    </span>
  );
}

function CompareView() {
  const { t, locale } = useI18n();
  const { siteId } = useApp();
  const [preset, setPreset] = useState<Preset>('day');
  const [anchor] = useState(minuteNow);
  const initial = useMemo(() => ({ aFrom: new Date(anchor.getTime() - 2 * SPAN.day), aTo: new Date(anchor.getTime() - SPAN.day), bFrom: new Date(anchor.getTime() - SPAN.day), bTo: anchor }), [anchor]);
  const [custom, setCustom] = useState(initial);

  const range = preset === 'custom' ? custom : { aFrom: new Date(anchor.getTime() - 2 * SPAN[preset]), aTo: new Date(anchor.getTime() - SPAN[preset]), bFrom: new Date(anchor.getTime() - SPAN[preset]), bTo: anchor };
  const valid = range.aTo > range.aFrom && range.bTo > range.bFrom;
  const query = useQuery<Comparison>(
    valid ? `/time-machine/compare${qs({ a_from: range.aFrom.toISOString(), a_to: range.aTo.toISOString(), b_from: range.bFrom.toISOString(), b_to: range.bTo.toISOString(), site_id: siteId })}` : null,
    [],
    600_000,
  );
  const periodLabel = (p: PeriodStats) => `${absoluteTime(p.from, locale)} → ${absoluteTime(p.to, locale)}`;
  const dateField = (label: string, key: keyof typeof custom) => (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          type="datetime-local"
          dir="ltr"
          value={toLocalInput(custom[key])}
          max={toLocalInput(new Date())}
          onChange={(e) => {
            const iso = fromLocalInput(e.target.value);
            if (iso) setCustom({ ...custom, [key]: new Date(iso) });
          }}
        />
      )}
    </Field>
  );

  return (
    <div className="space-y-4">
      <Card>
        <Segmented label={t('tm.tab.compare')} value={preset} onChange={setPreset} options={(['hour', 'day', 'week', 'custom'] as const).map((p) => ({ value: p, label: t(`tm.preset.${p}`) }))} />
        {preset === 'custom' && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {dateField(`${t('tm.periodA')} · ${t('tm.from')}`, 'aFrom')}
            {dateField(`${t('tm.periodA')} · ${t('tm.to')}`, 'aTo')}
            {dateField(`${t('tm.periodB')} · ${t('tm.from')}`, 'bFrom')}
            {dateField(`${t('tm.periodB')} · ${t('tm.to')}`, 'bTo')}
          </div>
        )}
      </Card>
      <Async query={query}>
        {(c) => {
          const roles = [...new Set([...c.a.checks, ...c.b.checks].map((x) => x.role))];
          const types = [...new Set([...Object.keys(c.a.events), ...Object.keys(c.b.events)])].sort();
          const row = (label: string, a: React.ReactNode, b: React.ReactNode, delta: React.ReactNode) => (
            <tr key={label}>
              <th scope="row" className="px-4 py-2 text-start font-normal text-muted">{label}</th>
              <td className="tnum px-3 py-2 text-end">{a}</td>
              <td className="tnum px-3 py-2 text-end">{b}</td>
              <td className="tnum px-4 py-2 text-end">{delta}</td>
            </tr>
          );
          return (
            <>
              <Card padded={false}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-xs text-muted">
                        <th scope="col" className="px-4 py-2.5 text-start font-medium">{t('tm.metric')}</th>
                        <th scope="col" className="px-3 py-2.5 text-end font-medium">
                          {t('tm.periodA')}
                          <span className="block text-[11px] font-normal text-faint">{periodLabel(c.a)}</span>
                        </th>
                        <th scope="col" className="px-3 py-2.5 text-end font-medium">
                          {t('tm.periodB')}
                          <span className="block text-[11px] font-normal text-faint">{periodLabel(c.b)}</span>
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-end font-medium">{t('tm.change')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {row(t('tm.devicesSeen'), c.a.devices_seen, c.b.devices_seen, <Delta a={c.a.devices_seen} b={c.b.devices_seen} unit="" lowerIsBetter={false} />)}
                      {row(t('tm.newDevices'), c.a.new_devices, c.b.new_devices, <span className="text-muted">{c.b.new_devices - c.a.new_devices}</span>)}
                      {row(t('tm.incidentCount'), c.a.incidents, c.b.incidents, <Delta a={c.a.incidents} b={c.b.incidents} unit="" lowerIsBetter />)}
                      {row(t('tm.incidentMinutes'), c.a.incident_minutes, c.b.incident_minutes, <Delta a={c.a.incident_minutes} b={c.b.incident_minutes} unit="" lowerIsBetter />)}
                      {roles.flatMap((role) => {
                        const a = c.a.checks.find((x) => x.role === role);
                        const b = c.b.checks.find((x) => x.role === role);
                        const name = t(`monitoring.role.${role}` as Key);
                        return [
                          row(`${name} · ${t('tm.availability')}`, pct(a?.availability_pct, 2), pct(b?.availability_pct, 2), <Delta a={a?.availability_pct ?? null} b={b?.availability_pct ?? null} unit=" pp" lowerIsBetter={false} digits={2} />),
                          row(`${name} · ${t('tm.latency')}`, ms(a?.latency_ms), ms(b?.latency_ms), <Delta a={a?.latency_ms ?? null} b={b?.latency_ms ?? null} unit=" ms" lowerIsBetter digits={1} />),
                          ...(role === 'gateway' || role === 'internet'
                            ? [row(`${name} · ${t('tm.loss')}`, pct(a?.loss_pct), pct(b?.loss_pct), <Delta a={a?.loss_pct ?? null} b={b?.loss_pct ?? null} unit=" pp" lowerIsBetter digits={1} />)]
                            : []),
                        ];
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
              <div className="grid gap-4 xl:grid-cols-2">
                <Card title={`${t('tm.onlyInA')} (${c.devices_only_in_a.length})`} padded={false}>
                  {c.devices_only_in_a.length ? <DeviceTable devices={c.devices_only_in_a} showStatus={false} /> : <EmptyState title={t('tm.noDiff')} />}
                </Card>
                <Card title={`${t('tm.onlyInB')} (${c.devices_only_in_b.length})`} padded={false}>
                  {c.devices_only_in_b.length ? <DeviceTable devices={c.devices_only_in_b} showStatus={false} /> : <EmptyState title={t('tm.noDiff')} />}
                </Card>
                {(['a', 'b'] as const).map((k) => {
                  const list = k === 'a' ? c.incidents_a : c.incidents_b;
                  return (
                    <Card key={k} title={`${t(k === 'a' ? 'tm.periodA' : 'tm.periodB')} · ${t('tm.incidentCount')} (${list.length})`} padded={false}>
                      {list.length ? (
                        <ul className="divide-y divide-line">
                          {list.map((i) => (
                            <li key={i.id}>
                              <IncidentRow incident={i} showSite={!siteId} />
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <EmptyState title={t('tm.noIncidents')} />
                      )}
                    </Card>
                  );
                })}
              </div>
              {types.length > 0 && (
                <Card title={t('tm.eventsByType')} padded={false}>
                  <table className="w-full text-[13px]">
                    <tbody className="divide-y divide-line">
                      {types.map((type) => row(EVENT_TYPE_LABEL[type]?.[locale] ?? type, c.a.events[type] ?? 0, c.b.events[type] ?? 0, <span className="text-muted">{(c.b.events[type] ?? 0) - (c.a.events[type] ?? 0)}</span>))}
                    </tbody>
                  </table>
                </Card>
              )}
            </>
          );
        }}
      </Async>
    </div>
  );
}

export default function TimeMachinePage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'snapshot' | 'compare'>('snapshot');
  return (
    <>
      <PageHeader
        title={t('tm.title')}
        description={t('tm.intro')}
        actions={<Segmented label={t('tm.title')} value={tab} onChange={setTab} options={[{ value: 'snapshot', label: t('tm.tab.snapshot') }, { value: 'compare', label: t('tm.tab.compare') }]} />}
      />
      {tab === 'snapshot' ? <SnapshotView /> : <CompareView />}
    </>
  );
}
