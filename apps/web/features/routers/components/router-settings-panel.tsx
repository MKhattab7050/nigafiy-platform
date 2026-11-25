'use client';

import { Plus, Power, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Async, Badge, Button, Card, DataTable, EmptyState, Fact, Field, Input, Modal, Select, SkeletonBlock, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import type { PortForwardRule, PortProtocol, QueuedRequest, RouterClient, RouterDetail, RouterReservation, RouterSettingsView, WifiNetwork } from '../types';
import { RequestProgress } from './request-progress';
import { RouterErrorNote } from './text';
import { DeviceLink } from '@/components/device-link';

// The router's own settings (docs/features/router-controls.md): overview, Wi-Fi networks, DHCP
// reservations, port forwarding and restart. Everything shown is what the router last reported;
// every change is an explicit administrator request that the site's collector carries out and
// then re-reads, so the page always shows what the router really did.

export type Confirm =
  | { kind: 'wifi_off'; net: WifiNetwork }
  | { kind: 'unreserve'; res: RouterReservation }
  | { kind: 'remove_forward'; rule: PortForwardRule }
  | { kind: 'reboot' };

export function duration(seconds: number, t: (k: Key) => string): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return fill(t('routers.duration.days'), { d, h });
  if (h > 0) return fill(t('routers.duration.hours'), { h, m });
  return fill(t('routers.duration.minutes'), { m });
}

export const portRange = (a: number, b: number) => (a === b ? String(a) : `${a}–${b}`);

const WAN_TONE = { up: 'ok', down: 'crit', connecting: 'warn', unknown: 'idle' } as const;

export function RouterSettingsPanel({
  router: r,
  clients,
  canAdmin,
  onChanged,
}: {
  router: RouterDetail;
  clients: RouterClient[];
  canAdmin: boolean;
  onChanged: () => void;
}) {
  const { t, tn, locale } = useI18n();
  const query = useQuery<RouterSettingsView>(`/routers/${r.id}/settings`, ['devices', 'collectors'], 15_000);
  const [activeReq, setActiveReq] = useState<QueuedRequest | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const supported = (cap: string) => r.capabilities?.some((c) => c.capability === cap && c.supported) ?? false;
  const capNote = (cap: string) => r.capabilities?.find((c) => c.capability === cap)?.note;

  /** Sends one control request; returns whether the API queued it. */
  async function run(path: string, method: 'POST' | 'DELETE', body?: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const q = await api<QueuedRequest>(`/routers/${r.id}/${path}`, { method, body });
      setActiveReq(q);
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const settled = () => {
    query.reload();
    onChanged();
  };

  return (
    <Async query={query} skeleton={<SkeletonBlock lines={8} />}>
      {(s) => (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span title={s.settings_at ? absoluteTime(s.settings_at, locale) : undefined}>
              {s.settings_at ? fill(t('routers.settings.readAt'), { when: relativeTime(s.settings_at, locale) }) : t('routers.settings.notRead')}
            </span>
            {s.pending.length > 0 && <Badge tone="info">{fill(tn('routers.settings.pending', s.pending.length), { count: s.pending.length })}</Badge>}
          </div>
          {!canAdmin && <p className="text-xs text-muted">{t('routers.settings.adminOnly')}</p>}

          {activeReq && (
            <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
              <RequestProgress key={activeReq.request_id} requestId={activeReq.request_id} routerId={r.id} collector={activeReq.collector} onSettled={settled} />
            </div>
          )}
          <RouterErrorNote error={error} routerId={r.id} />

          {supported('overview') && <OverviewCard s={s} />}

          <Card title={t('routers.wifi.title')} description={t('routers.wifi.hint')} padded={false}>
            {!supported('wifi') ? (
              <NotOffered note={capNote('wifi')} />
            ) : !s.wifi ? (
              <EmptyState title={t('routers.settings.notRead')} />
            ) : s.wifi.length === 0 ? (
              <EmptyState title={t('routers.wifi.none')} />
            ) : (
              <DataTable stack>
                <thead>
                  <tr>
                    <th scope="col">{t('routers.wifi.ssid')}</th>
                    <th scope="col">{t('routers.wifi.band')}</th>
                    <th scope="col">{t('routers.wifi.kind')}</th>
                    <th scope="col">{t('routers.wifi.security')}</th>
                    <th scope="col">{t('routers.wifi.clients')}</th>
                    <th scope="col" className="text-end">
                      {t('routers.wifi.state')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.wifi.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <bdi className="font-medium text-fg">{w.ssid}</bdi>
                        {w.hidden && <span className="ms-2 text-xs text-muted">{t('routers.wifi.hidden')}</span>}
                      </td>
                      <td data-label={t('routers.wifi.band')}>{w.band ?? '—'}</td>
                      <td data-label={t('routers.wifi.kind')}>
                        <Badge tone={w.main ? 'info' : 'idle'} dot={false}>
                          {t(w.main ? 'routers.wifi.main' : 'routers.wifi.guest')}
                        </Badge>
                      </td>
                      <td data-label={t('routers.wifi.security')}>{w.security || '—'}</td>
                      <td data-label={t('routers.wifi.clients')}>
                        <span className="mono">{w.client_count ?? '—'}</span>
                      </td>
                      <td data-label={t('routers.wifi.state')}>
                        <div className="flex justify-end">
                          <Switch
                            checked={w.enabled}
                            disabled={!canAdmin || busy}
                            label={fill(t('routers.wifi.toggle'), { ssid: w.ssid })}
                            onChange={(next) => {
                              if (next) void run('wifi', 'POST', { wifi_id: w.id, enabled: true });
                              else setConfirm({ kind: 'wifi_off', net: w });
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>

          <Card title={t('routers.res.title')} description={t('routers.res.hint')} padded={false}>
            {!supported('reservations') ? (
              <NotOffered note={capNote('reservations')} />
            ) : !s.reservations ? (
              <EmptyState title={t('routers.settings.notRead')} />
            ) : (
              <>
                {s.reservations.length === 0 ? (
                  <EmptyState title={t('routers.res.none')} />
                ) : (
                  <DataTable stack>
                    <thead>
                      <tr>
                        <th scope="col">{t('routers.res.device')}</th>
                        <th scope="col">{t('routers.res.ip')}</th>
                        <th scope="col">{t('routers.client.mac')}</th>
                        {canAdmin && <th scope="col" className="text-end" />}
                      </tr>
                    </thead>
                    <tbody>
                      {s.reservations.map((x) => (
                        <tr key={x.id}>
                          <td>
                            <DeviceName id={x.device_id} label={x.device_label} />
                            {x.enabled === false && <span className="block text-xs text-warn">{t('routers.res.disabled')}</span>}
                          </td>
                          <td data-label={t('routers.res.ip')}>
                            <bdi className="mono">{x.ip}</bdi>
                          </td>
                          <td data-label={t('routers.client.mac')}>
                            <bdi className="mono text-xs">{x.mac}</bdi>
                          </td>
                          {canAdmin && (
                            <td>
                              <div className="flex justify-end">
                                {/* Also for entries whose MAC matches no device record: removed by MAC. */}
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm({ kind: 'unreserve', res: x })}>
                                  <Trash2 className="size-3.5" aria-hidden />
                                  {t('routers.res.remove')}
                                </Button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                )}
                {canAdmin && (
                  <ReserveForm
                    clients={clients}
                    reservations={s.reservations}
                    cidr={s.lan.cidr}
                    busy={busy}
                    onSubmit={(device_id, ip) => run('reservations', 'POST', { device_id, ip })}
                  />
                )}
              </>
            )}
          </Card>

          <Card title={t('routers.pf.title')} description={t('routers.pf.hint')} padded={false}>
            {!supported('port_forward') ? (
              <NotOffered note={capNote('port_forward')} />
            ) : !s.port_forwards ? (
              <EmptyState title={t('routers.settings.notRead')} />
            ) : (
              <>
                {s.port_forwards.length === 0 ? (
                  <EmptyState title={t('routers.pf.none')} />
                ) : (
                  <PortForwardTable rules={s.port_forwards} canAdmin={canAdmin} busy={busy} onRemove={(rule) => setConfirm({ kind: 'remove_forward', rule })} />
                )}
                {canAdmin && <PortForwardForm clients={clients} busy={busy} onSubmit={(body) => run('port-forwards', 'POST', body)} />}
              </>
            )}
          </Card>

          {supported('reboot') && canAdmin && (
            <Card title={t('routers.reboot.title')} description={t('routers.reboot.hint')}>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirm({ kind: 'reboot' })}>
                <Power className="size-3.5" aria-hidden />
                {t('routers.reboot.button')}
              </Button>
            </Card>
          )}

          {confirm && (
            <ConfirmModal
              confirm={confirm}
              routerName={r.name}
              busy={busy}
              onClose={() => setConfirm(null)}
              onConfirm={async () => {
                const c = confirm;
                const ok =
                  c.kind === 'wifi_off'
                    ? await run('wifi', 'POST', { wifi_id: c.net.id, enabled: false, ...(c.net.main ? { confirm: true } : {}) })
                    : c.kind === 'unreserve'
                      ? await run(c.res.device_id ? `reservations/${c.res.device_id}` : `reservations/by-mac/${encodeURIComponent(c.res.mac)}`, 'DELETE')
                      : c.kind === 'remove_forward'
                        ? await run(`port-forwards/${encodeURIComponent(c.rule.id)}`, 'DELETE')
                        : await run('reboot', 'POST', { confirm: 'reboot' });
                setConfirm(null);
                return ok;
              }}
            />
          )}
        </div>
      )}
    </Async>
  );
}

function NotOffered({ note }: { note?: string }) {
  const { t } = useI18n();
  return (
    <div className="px-4 py-3 text-[13px] text-muted">
      <p>{t('routers.settings.notOffered')}</p>
      {note && (
        <p className="mt-1 text-xs text-faint" dir="auto">
          {note}
        </p>
      )}
    </div>
  );
}

function DeviceName({ id, label }: { id?: string | null; label?: string | null }) {
  const { t } = useI18n();
  if (id) {
    return (
      <DeviceLink id={id} className="font-medium text-fg hover:text-accent-hover hover:underline">
        <bdi>{label ?? id}</bdi>
      </DeviceLink>
    );
  }
  return <span className="text-muted">{label ? <bdi>{label}</bdi> : t('routers.res.unknownDevice')}</span>;
}

function OverviewCard({ s }: { s: RouterSettingsView }) {
  const { t } = useI18n();
  const o = s.overview;
  if (!o) {
    return (
      <Card title={t('routers.overview.title')}>
        <p className="text-[13px] text-muted">{t('routers.settings.notRead')}</p>
      </Card>
    );
  }
  return (
    <Card title={t('routers.overview.title')}>
      <div className="grid gap-4 lg:grid-cols-2">
        <dl>
          {o.uptime_seconds !== undefined && <Fact label={t('routers.overview.uptime')}>{duration(o.uptime_seconds, t)}</Fact>}
          {o.lan_ip && (
            <Fact label={t('routers.overview.lan')}>
              <bdi className="mono">{o.lan_ip}</bdi>
            </Fact>
          )}
          <Fact label={t('routers.overview.subnet')} source={s.lan.source === 'assumed_24' ? t('routers.overview.subnetAssumed') : undefined}>
            <bdi className="mono">{s.lan.cidr}</bdi>
          </Fact>
        </dl>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">{t('routers.overview.wan')}</p>
          {!o.wan || o.wan.length === 0 ? (
            <p className="text-xs text-muted">{t('routers.overview.wanNone')}</p>
          ) : (
            <ul className="space-y-2">
              {o.wan.map((w) => (
                <li key={w.name} className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <bdi className="font-medium text-fg">{w.name}</bdi>
                    {w.type && <span className="text-muted">{w.type}</span>}
                    <Badge tone={WAN_TONE[w.status]}>{t(`routers.wan.${w.status}` as Key)}</Badge>
                    {w.uptime_seconds !== undefined && <span className="text-muted">{duration(w.uptime_seconds, t)}</span>}
                  </div>
                  {(w.ipv4 || w.dns?.length) && (
                    <p className="mt-1 text-muted">
                      {w.ipv4 && <bdi className="mono">{w.ipv4}</bdi>}
                      {w.dns?.length ? (
                        <>
                          {w.ipv4 ? ' · ' : ''}
                          {t('routers.overview.dns')} <bdi className="mono">{w.dns.join(', ')}</bdi>
                        </>
                      ) : null}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

export function PortForwardTable({
  rules,
  canAdmin,
  busy,
  onRemove,
  hideDevice,
}: {
  rules: PortForwardRule[];
  canAdmin: boolean;
  busy: boolean;
  onRemove: (rule: PortForwardRule) => void;
  hideDevice?: boolean;
}) {
  const { t } = useI18n();
  return (
    <DataTable stack>
      <thead>
        <tr>
          <th scope="col">{t('routers.pf.rule')}</th>
          <th scope="col">{t('routers.pf.external')}</th>
          <th scope="col">{t('routers.pf.internal')}</th>
          <th scope="col">{t('routers.pf.owner')}</th>
          {canAdmin && <th scope="col" className="text-end" />}
        </tr>
      </thead>
      <tbody>
        {rules.map((x) => (
          <tr key={x.id}>
            <td>
              <bdi className="font-medium text-fg">{x.description || '—'}</bdi>
              {!x.enabled && <span className="block text-xs text-warn">{t('routers.pf.disabled')}</span>}
            </td>
            <td data-label={t('routers.pf.external')}>
              <span className="mono" dir="ltr">
                {t(`routers.pf.proto.${x.protocol}` as Key)} {portRange(x.external_start, x.external_end)}
              </span>
            </td>
            <td data-label={t('routers.pf.internal')}>
              <span className="mono" dir="ltr">
                {x.internal_ip}:{portRange(x.internal_start, x.internal_end)}
              </span>
              {!hideDevice && (
                <span className="block text-xs">
                  <DeviceName id={x.device_id} label={x.device_label} />
                </span>
              )}
            </td>
            <td data-label={t('routers.pf.owner')}>
              <Badge tone={x.owner === 'lan-detective' ? 'info' : 'warn'} dot={false}>
                {t(`routers.pf.owner.${x.owner}` as Key)}
              </Badge>
            </td>
            {canAdmin && (
              <td>
                <div className="flex justify-end">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemove(x)}>
                    <Trash2 className="size-3.5" aria-hidden />
                    {t('routers.pf.remove')}
                  </Button>
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function ReserveForm({
  clients,
  reservations,
  cidr,
  busy,
  onSubmit,
}: {
  clients: RouterClient[];
  reservations: RouterReservation[];
  cidr: string;
  busy: boolean;
  onSubmit: (deviceId: string, ip: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const choices = useMemo(() => clients.filter((c) => c.device_id && c.ip), [clients]);
  const [deviceId, setDeviceId] = useState('');
  const [ip, setIp] = useState('');
  const reservedFor = new Map(reservations.map((x) => [x.mac, x.ip]));

  if (!open) {
    return (
      <div className="border-t border-line px-4 py-3">
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={choices.length === 0}>
          <Plus className="size-3.5" aria-hidden />
          {t('routers.res.add')}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="space-y-3 border-t border-line px-4 py-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSubmit(deviceId, ip.trim())) setOpen(false);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('routers.res.device')}>
          {(id) => (
            <Select
              id={id}
              value={deviceId}
              required
              onChange={(e) => {
                setDeviceId(e.target.value);
                const c = choices.find((x) => x.device_id === e.target.value);
                if (c?.ip) setIp(c.ip);
              }}
            >
              <option value="">{t('routers.res.chooseDevice')}</option>
              {choices.map((c) => (
                <option key={c.mac} value={c.device_id!}>
                  {`${c.device_label || c.hostname || c.mac} · ${c.ip}${reservedFor.has(c.mac) ? ` (${fill(t('routers.res.current'), { ip: reservedFor.get(c.mac)! })})` : ''}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('routers.res.ip')} hint={fill(t('routers.res.ipHint'), { cidr })}>
          {(id) => <Input id={id} value={ip} onChange={(e) => setIp(e.target.value)} required className="mono" dir="ltr" inputMode="decimal" />}
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('routers.cancel')}
        </Button>
        <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!deviceId || !ip.trim()}>
          {t('routers.res.reserve')}
        </Button>
      </div>
    </form>
  );
}

export function PortForwardForm({
  clients,
  deviceId: fixedDevice,
  busy,
  onSubmit,
}: {
  clients?: RouterClient[];
  /** When the form belongs to one device (the device page), no device choice is shown. */
  deviceId?: string;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const choices = useMemo(() => (clients ?? []).filter((c) => c.device_id && c.ip), [clients]);
  const [deviceId, setDeviceId] = useState(fixedDevice ?? '');
  const [description, setDescription] = useState('');
  const [protocol, setProtocol] = useState<PortProtocol>('tcp');
  const [extStart, setExtStart] = useState('');
  const [extEnd, setExtEnd] = useState('');
  const [intStart, setIntStart] = useState('');

  if (!open) {
    return (
      <div className="border-t border-line px-4 py-3">
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={!fixedDevice && choices.length === 0}>
          <Plus className="size-3.5" aria-hidden />
          {t('routers.pf.add')}
        </Button>
      </div>
    );
  }
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  return (
    <form
      className="space-y-3 border-t border-line px-4 py-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const body: Record<string, unknown> = { device_id: deviceId, description: description.trim(), protocol, external_start: Number(extStart) };
        if (num(extEnd) !== undefined) body.external_end = num(extEnd);
        if (num(intStart) !== undefined) body.internal_start = num(intStart);
        if (await onSubmit(body)) {
          setOpen(false);
          setDescription('');
          setExtStart('');
          setExtEnd('');
          setIntStart('');
        }
      }}
    >
      <p className="rounded-[6px] border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg">{t('routers.pf.exposeWarning')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {!fixedDevice && (
          <Field label={t('routers.res.device')}>
            {(id) => (
              <Select id={id} value={deviceId} required onChange={(e) => setDeviceId(e.target.value)}>
                <option value="">{t('routers.res.chooseDevice')}</option>
                {choices.map((c) => (
                  <option key={c.mac} value={c.device_id!}>{`${c.device_label || c.hostname || c.mac} · ${c.ip}`}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('routers.pf.description')} hint={t('routers.pf.descriptionHint')}>
          {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={60} dir="auto" />}
        </Field>
        <Field label={t('routers.pf.protocol')}>
          {(id) => (
            <Select id={id} value={protocol} onChange={(e) => setProtocol(e.target.value as PortProtocol)}>
              {(['tcp', 'udp', 'both'] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`routers.pf.proto.${p}` as Key)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('routers.pf.externalStart')}>
          {(id) => <Input id={id} type="number" min={1} max={65535} value={extStart} onChange={(e) => setExtStart(e.target.value)} required className="mono" dir="ltr" />}
        </Field>
        <Field label={t('routers.pf.externalEnd')} hint={t('routers.pf.optional')}>
          {(id) => <Input id={id} type="number" min={1} max={65535} value={extEnd} onChange={(e) => setExtEnd(e.target.value)} className="mono" dir="ltr" />}
        </Field>
        <Field label={t('routers.pf.internalStart')} hint={t('routers.pf.optional')}>
          {(id) => <Input id={id} type="number" min={1} max={65535} value={intStart} onChange={(e) => setIntStart(e.target.value)} className="mono" dir="ltr" />}
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('routers.cancel')}
        </Button>
        <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!deviceId || !description.trim() || !extStart}>
          {t('routers.pf.addButton')}
        </Button>
      </div>
    </form>
  );
}

export function ConfirmModal({
  confirm: c,
  routerName,
  busy,
  onClose,
  onConfirm,
}: {
  confirm: Confirm;
  routerName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  let title: string;
  let body: React.ReactNode;
  let action: string;
  if (c.kind === 'wifi_off') {
    const count = c.net.client_count ?? t('routers.wifi.unknownCount');
    title = fill(t('routers.wifi.confirmOffTitle'), { ssid: c.net.ssid });
    body = <p>{fill(t(c.net.main ? 'routers.wifi.confirmOffMain' : 'routers.wifi.confirmOff'), { count })}</p>;
    action = t('routers.wifi.turnOff');
  } else if (c.kind === 'unreserve') {
    title = fill(t('routers.res.removeTitle'), { device: c.res.device_label ?? c.res.mac });
    body = (
      <>
        <p>{fill(t('routers.res.removeBody'), { ip: c.res.ip })}</p>
        {!c.res.device_id && <p className="mt-2 text-sm text-muted">{t('routers.res.removeByMac')}</p>}
      </>
    );
    action = t('routers.res.remove');
  } else if (c.kind === 'remove_forward') {
    const r = c.rule;
    title = fill(t('routers.pf.removeTitle'), { rule: r.description || r.id });
    body = (
      <div className="space-y-2">
        <p className="mono" dir="ltr">
          {t(`routers.pf.proto.${r.protocol}` as Key)} {portRange(r.external_start, r.external_end)} → {r.internal_ip}:{portRange(r.internal_start, r.internal_end)}
        </p>
        <p>{t('routers.pf.removeBody')}</p>
        {r.owner === 'administrator' && <p className="rounded-[6px] border border-warn/40 bg-warn/10 px-3 py-2 text-xs">{t('routers.pf.removeAdmin')}</p>}
      </div>
    );
    action = t('routers.pf.remove');
  } else {
    title = fill(t('routers.reboot.confirmTitle'), { router: routerName });
    body = <p>{t('routers.reboot.confirmBody')}</p>;
    action = t('routers.reboot.confirm');
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4 text-[13px] leading-relaxed text-fg">
        {body}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('routers.cancel')}
          </Button>
          <Button size="sm" variant="danger" busy={busy} onClick={() => void onConfirm()}>
            {action}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
