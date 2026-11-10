'use client';

import { Activity, ArrowLeft, Ban, BellOff, ExternalLink, Power } from 'lucide-react';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { type Collector, DEVICE_TRUSTS, DEVICE_TYPES, type DeviceDetail, type DeviceTrust } from '@lan-detective/shared-types';
import { ConfidenceBadge } from '@/components/diagnosis';
import { EventList } from '@/components/event-list';
import { Async, Badge, Button, Card, CopyBlock, EmptyState, ErrorNote, Fact, Field, Input, PageHeader, Segmented, Select, StatusBadge, Tag, Textarea, statusTone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL, absoluteTime, duration, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';
import { accessText } from '@/lib/access-text';
import { DeviceAccessCard } from '@/components/access';

const WEEK_MS = 7 * 86_400_000;
const BAR = { ok: 'bg-ok', crit: 'bg-crit', idle: 'bg-idle', warn: 'bg-warn', info: 'bg-accent' } as const;

/** 7-day strip built from recorded status intervals. Gaps = before the device was first seen. */
function AvailabilityStrip({ device }: { device: DeviceDetail }) {
  const { t, locale } = useI18n();
  const end = Date.now();
  const start = end - WEEK_MS;
  const segments = device.availability
    .map((a) => {
      const from = Math.max(start, new Date(a.started_at).getTime());
      const to = a.ended_at ? Math.min(end, new Date(a.ended_at).getTime()) : end;
      return { ...a, from, to };
    })
    .filter((s) => s.to > s.from);
  if (!segments.length) return <EmptyState title={t('common.noData')} />;
  const totals = { online: 0, offline: 0, unknown: 0 };
  for (const s of segments) totals[s.status] += s.to - s.from;
  const known = totals.online + totals.offline;
  return (
    <div>
      <div className="relative h-7 overflow-hidden rounded bg-bg" dir="ltr" role="img" aria-label={t('device.availability')}>
        {segments.map((s, i) => (
          <span
            key={i}
            className={`absolute inset-y-0 ${BAR[statusTone(s.status)]}`}
            style={{ left: `${((s.from - start) / WEEK_MS) * 100}%`, width: `${Math.max(0.15, ((s.to - s.from) / WEEK_MS) * 100)}%` }}
            title={`${t(`status.${s.status}`)} · ${absoluteTime(s.started_at, locale)} → ${s.ended_at ? absoluteTime(s.ended_at, locale) : '…'} (${duration(s.started_at, s.ended_at)})`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-faint" dir="ltr">
        <span>−7d</span>
        <span>now</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {(['online', 'offline', 'unknown'] as const).map((s) => (
          <span key={s} className="tnum flex items-center gap-1.5">
            <span className={`size-2 rounded-sm ${BAR[statusTone(s)]}`} aria-hidden />
            {t(`status.${s}`)} {duration(new Date(0).toISOString(), new Date(totals[s]).toISOString())}
          </span>
        ))}
        {known > 0 && <span className="tnum ms-auto font-medium text-fg">{((totals.online / known) * 100).toFixed(2)}%</span>}
      </div>
    </div>
  );
}

/** What the device announced about itself, and the rule that turned it into a type. */
function Identification({ device: d, typeLabel }: { device: DeviceDetail; typeLabel: string }) {
  const { t } = useI18n();
  const fp = d.fingerprint ?? {};
  const model = fp.hints?.model ?? fp.hints?.product ?? fp.ssdp?.model;
  const manufacturer = fp.hints?.manufacturer ?? fp.ssdp?.manufacturer;
  const announced = Boolean(fp.names?.length || fp.services?.length || model || manufacturer || fp.ssdp);
  return (
    <div className="space-y-3">
      {d.type_source === 'inferred' && d.type_evidence && (
        <div className="rounded-md border border-line-strong bg-raised px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">
            {t('device.identRule')}: {typeLabel}
          </p>
          <ul className="mt-1.5 list-disc space-y-1 ps-5 text-[13px] leading-relaxed text-fg" dir="auto">
            {d.type_evidence.split(' · ').map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          {d.type_confidence === 'low' && <p className="mt-2 text-xs text-warn">{t('device.identLowHint')}</p>}
        </div>
      )}
      {!announced ? (
        <p className="text-[13px] leading-relaxed text-muted">{t('device.identNone')}</p>
      ) : (
        <dl>
          {fp.names && fp.names.length > 0 && (
            <Fact label={t('device.identNames')}>
              {fp.names.map((n) => (
                <span key={n.source + n.name} className="block" dir="auto">
                  {n.name} <span className="text-[11px] text-faint">· {n.source}</span>
                </span>
              ))}
            </Fact>
          )}
          {model && <Fact label={t('device.identModel')}>{model}</Fact>}
          {manufacturer && <Fact label={t('device.identManufacturer')}>{manufacturer}</Fact>}
          {fp.ssdp?.device_types && fp.ssdp.device_types.length > 0 && <Fact label={t('device.identUpnp')}>{fp.ssdp.device_types.join(', ')}</Fact>}
          {fp.ssdp?.server && (
            <Fact label={t('device.identSoftware')}>
              <span className="mono text-xs">{fp.ssdp.server}</span>
            </Fact>
          )}
          {fp.services && fp.services.length > 0 && (
            <Fact label={t('device.identServices')}>
              <span className="flex flex-wrap gap-1">
                {fp.services.map((s) => (
                  <Tag key={s}>{s}</Tag>
                ))}
              </span>
            </Fact>
          )}
        </dl>
      )}
    </div>
  );
}

function ManagePanel({ device, onSaved }: { device: DeviceDetail; onSaved: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const [form, setForm] = useState({ display_name: '', device_type: 'unknown', owner: '', notes: '', tags: '', is_critical: false });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    setForm({
      display_name: device.display_name ?? '',
      device_type: device.device_type,
      owner: device.owner ?? '',
      notes: device.notes ?? '',
      tags: device.tags.join(', '),
      is_critical: device.is_critical,
    });
    // Reset only when a different device is opened, not on every live refresh (would clobber typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  if (!can('technician')) return <p className="text-[13px] text-muted">{t('common.readOnly')}</p>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        display_name: form.display_name.trim() || null,
        owner: form.owner.trim() || null,
        notes: form.notes.trim() || null,
        is_critical: form.is_critical,
        tags: form.tags.split(/[,،]/).map((s) => s.trim()).filter(Boolean),
      };
      // Only send the type when the user changed it, so an inferred type is not silently turned into a manual one.
      if (form.device_type !== device.device_type) body.device_type = form.device_type;
      await api(`/devices/${device.id}`, { method: 'PATCH', body });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3.5">
      <Field label={t('device.displayName')}>{(id) => <Input id={id} value={form.display_name} maxLength={80} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />}</Field>
      <Field label={t('device.type')}>
        {(id) => (
          <Select id={id} value={form.device_type} onChange={(e) => setForm({ ...form, device_type: e.target.value })}>
            {DEVICE_TYPES.map((d) => (
              <option key={d} value={d}>
                {DEVICE_TYPE_LABEL[d]?.[locale]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('device.owner')}>{(id) => <Input id={id} value={form.owner} maxLength={80} onChange={(e) => setForm({ ...form, owner: e.target.value })} />}</Field>
      <Field label={t('device.tags')} hint={t('device.tagsHint')}>{(id) => <Input id={id} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />}</Field>
      <Field label={t('device.notes')}>{(id) => <Textarea id={id} value={form.notes} maxLength={4000} rows={3} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}</Field>
      <label className="flex cursor-pointer items-start gap-2.5">
        <input type="checkbox" checked={form.is_critical} onChange={(e) => setForm({ ...form, is_critical: e.target.checked })} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
        <span>
          <span className="block text-[13px] text-fg">{t('device.criticalLabel')}</span>
          <span className="block text-xs text-muted">{t('device.criticalHint')}</span>
        </span>
      </label>
      <ErrorNote error={error} />
      <Button type="submit" variant="primary" busy={busy}>
        {saved ? t('common.saved') : t('common.save')}
      </Button>
    </form>
  );
}

/** Things the user can do about a device. Removing a device happens on the router; we explain how. */
function ControlsPanel({ device: d, onChanged }: { device: DeviceDetail; onChanged: () => void }) {
  const { t } = useI18n();
  const { can } = useApp();
  const collectors = useQuery<{ items: Collector[] }>('/collectors', ['collectors']);
  const gateway = collectors.data?.items.find((c) => c.site_id === d.site_id && c.gateway_ip)?.gateway_ip ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [wakeVia, setWakeVia] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  }

  const tech = can('technician');
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">{t('ctl.trustLabel')}</p>
        <Segmented<DeviceTrust>
          label={t('ctl.trustLabel')}
          value={d.trust}
          options={DEVICE_TRUSTS.map((v) => ({ value: v, label: t(`trust.${v}`) }))}
          onChange={(trust) => tech && trust !== d.trust && run('trust', () => api(`/devices/${d.id}`, { method: 'PATCH', body: { trust } }))}
        />
        <p className={`mt-1.5 text-xs ${d.trust === 'unwanted' ? 'text-crit' : 'text-faint'}`}>{t(`ctl.trustHint.${d.trust}`)}</p>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          disabled={!tech || busy === 'mute'}
          checked={d.alerts_muted}
          onChange={(e) => run('mute', () => api(`/devices/${d.id}`, { method: 'PATCH', body: { alerts_muted: e.target.checked } }))}
          className="mt-0.5 size-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-[13px] text-fg">{t('ctl.mute')}</span>
          <span className="block text-xs text-muted">{t('ctl.muteHint')}</span>
        </span>
      </label>

      <div className="space-y-1.5 border-t border-line pt-4">
        {d.monitor_check_id ? (
          <p className="flex items-center gap-2 text-[13px] text-ok">
            <Activity className="size-4" aria-hidden />
            {t('ctl.monitored')}
            <Link href="/monitoring" className="ms-auto text-xs text-accent-hover hover:underline">
              {t('ctl.openMonitoring')}
            </Link>
          </p>
        ) : (
          can('admin') && (
            <Button busy={busy === 'monitor'} disabled={!d.current_ip} onClick={() => run('monitor', () => api(`/devices/${d.id}/monitor`, { method: 'POST' }))}>
              <Activity className="size-4" aria-hidden />
              {t('ctl.monitor')}
            </Button>
          )
        )}
        <p className="text-xs text-faint">{t('ctl.monitorHint')}</p>
      </div>

      {tech && d.primary_mac && (
        <div className="space-y-1.5">
          <Button
            busy={busy === 'wake'}
            onClick={() =>
              run('wake', async () => {
                const res = await api<{ collector: string }>(`/devices/${d.id}/wake`, { method: 'POST' });
                setWakeVia(res.collector);
              })
            }
          >
            <Power className="size-4" aria-hidden />
            {t('ctl.wake')}
          </Button>
          {wakeVia && (
            <p className="text-xs text-ok" role="status">
              {t('ctl.wakeSent')} {wakeVia}
            </p>
          )}
          <p className="text-xs text-faint">{t('ctl.wakeHint')}</p>
        </div>
      )}

      <ErrorNote error={error} />

      <details className={`rounded-md border px-3 py-2.5 ${d.trust === 'unwanted' ? 'border-crit/40 bg-crit/5' : 'border-line'}`} open={d.trust === 'unwanted'}>
        <summary className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-fg">
          <Ban className="size-4 text-crit" aria-hidden />
          {t('ctl.block')}
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-muted">{t('ctl.blockBody')}</p>
        <div className="mt-3 space-y-3">
          {d.primary_mac ? <CopyBlock label={t('ctl.macToBlock')} value={d.primary_mac} /> : <p className="text-xs text-warn">{t('ctl.noMac')}</p>}
          {gateway && (
            <a
              href={`http://${gateway}/`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 text-xs font-medium text-fg hover:bg-line"
            >
              {t('ctl.openRouter')} <span className="mono text-muted">{gateway}</span>
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </details>
    </div>
  );
}

export default function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const query = useQuery<DeviceDetail>(`/devices/${id}`, ['devices', 'events']);

  return (
    <>
      <Link href="/devices" className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {t('device.back')}
      </Link>
      <Async query={query}>
        {(d) => {
          const typeLabel = DEVICE_TYPE_LABEL[d.device_type]?.[locale] ?? d.device_type;
          return (
            <>
              <PageHeader
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
              {d.status === 'unknown' && <p className="mb-4 rounded-md border border-line-strong bg-raised px-3 py-2 text-[13px] text-muted">{t('device.statusUnknownHint')}</p>}
              <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
                <div className="space-y-4">
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
                  <Card title={t('device.identification')} action={d.type_source === 'inferred' && d.type_confidence ? <ConfidenceBadge confidence={d.type_confidence} /> : undefined}>
                    <Identification device={d} typeLabel={typeLabel} />
                  </Card>
                  <Card title={t('device.availability')}>
                    <AvailabilityStrip device={d} />
                  </Card>
                  <Card title={t('device.events')} padded={false}>
                    {d.recent_events.length ? <EventList events={d.recent_events} showSite={false} linkDevice={false} /> : <EmptyState title={t('device.noEvents')} />}
                  </Card>
                </div>
                <div className="space-y-4">
                  <Card title={accessText(locale).deviceCard}>
                    <DeviceAccessCard deviceId={d.id} siteId={d.site_id} />
                  </Card>
                  <Card title={t('ctl.title')}>
                    <ControlsPanel device={d} onChanged={query.reload} />
                  </Card>
                  <Card title={t('device.manage')}>
                    <ManagePanel device={d} onSaved={query.reload} />
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
