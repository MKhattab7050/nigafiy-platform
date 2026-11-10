'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { DEVICE_TYPES, type DeviceDetail } from '@lan-detective/shared-types';
import { EventList } from '@/components/event-list';
import { Async, Button, Card, EmptyState, ErrorNote, Fact, Field, Input, PageHeader, Select, StatusBadge, Tag, Textarea, statusTone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL, absoluteTime, duration, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

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
                      <Fact label={t('device.hostname')} source={d.hostname ? t('device.hostnameSource') : undefined}>
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
                  <Card title={t('device.availability')}>
                    <AvailabilityStrip device={d} />
                  </Card>
                  <Card title={t('device.events')} padded={false}>
                    {d.recent_events.length ? <EventList events={d.recent_events} showSite={false} linkDevice={false} /> : <EmptyState title={t('device.noEvents')} />}
                  </Card>
                </div>
                <div className="space-y-4">
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
