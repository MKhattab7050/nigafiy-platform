'use client';

import { Ban, CheckCircle2, Clock, Gauge, Network, Pencil, Pin, PinOff, Router, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ActionButton } from '@/components/control-action';
import { Badge, Button, Card, CopyBlock, Fact, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { type ControlAction, apiPath } from '@/lib/controls';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import type { DeviceRef, DeviceRouterControls, QueuedRequest } from '../types';
import { BlockDialog } from './block-dialog';
import { RequestProgress } from './request-progress';
import { type Confirm, ConfirmModal, PortForwardForm, PortForwardTable } from './router-settings-panel';
import { ConnectionLabel, DELIVERY_TONE, HEALTH_TONE, RouterErrorNote, leaseText } from './text';

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export function DeviceRouterCard({
  device,
  routerSection,
  gatewayIp,
  onChanged,
}: {
  device: DeviceRef;
  routerSection: DeviceRouterControls;
  gatewayIp?: string | null;
  onChanged: () => void;
}) {
  const { t } = useI18n();

  if (routerSection.routers.length === 0) {
    return (
      <Card title={t('routers.section.title')}>
        <div className="space-y-3 text-[13px] text-muted">
          <p>{t('routers.section.none')}</p>
          <p className="text-xs leading-relaxed">{t('routers.section.manual')}</p>
          {device.mac ? (
            <CopyBlock label={t('routers.section.macToBlock')} value={device.mac} />
          ) : (
            <p className="text-xs text-faint">{t('ctl.noMac')}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Link
              href="/routers"
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-on-accent hover:bg-accent-strong"
            >
              <Router className="size-3.5" aria-hidden />
              {t('routers.section.addRouter')}
            </Link>
            {gatewayIp && (
              <a
                href={`http://${gatewayIp}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 text-xs font-medium text-fg hover:bg-raised"
              >
                {t('routers.section.openRouterPage')} ({gatewayIp}) ↗
              </a>
            )}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card title={t('routers.section.title')}>
      <div className="space-y-4">
        {routerSection.protected && (
          <div className="rounded-[var(--radius-control)] border border-line-strong bg-sunken px-3 py-2 text-xs text-muted">
            <span className="font-medium text-fg">{t('routers.section.protected')}: </span>
            {routerSection.protected.message}
          </div>
        )}
        {routerSection.routers.map((entry) => (
          <RouterDeviceRow key={entry.router_id} entry={entry} device={device} onChanged={onChanged} />
        ))}
      </div>
    </Card>
  );
}

function RouterDeviceRow({
  entry,
  device,
  onChanged,
}: {
  entry: DeviceRouterControls['routers'][number];
  device: DeviceRef;
  onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const [dialogAction, setDialogAction] = useState<'block' | 'unblock' | null>(null);
  const [activeReq, setActiveReq] = useState<QueuedRequest | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [showLimit, setShowLimit] = useState(false);
  const [downKbps, setDownKbps] = useState('5000');
  const [upKbps, setUpKbps] = useState('2000');
  const [showSchedule, setShowSchedule] = useState(false);
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [fromTime, setFromTime] = useState('22:00');
  const [toTime, setToTime] = useState('07:00');
  const [busy, setBusy] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [newName, setNewName] = useState(device.label);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /** Which part of the card started the latest request: its progress and errors show there. */
  const [origin, setOrigin] = useState<'top' | 'settings'>('top');

  /** Runs one action exactly as GET /devices/:id/controls described it. */
  async function runAction(action: ControlAction | undefined, body?: Record<string, unknown>): Promise<boolean> {
    if (!action?.possible || !action.href) return false;
    setOrigin('settings');
    setBusy(true);
    setError(null);
    try {
      const method = action.method ?? 'POST';
      const q = await api<QueuedRequest>(apiPath(action.href), { method, body: method === 'DELETE' ? undefined : { ...action.body, ...body } });
      setActiveReq(q);
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function applyLimit(limit: { down_kbps: number; up_kbps: number } | null) {
    setOrigin('top');
    setBusy(true);
    setError(null);
    try {
      const q = await api<QueuedRequest>(`/routers/${entry.router_id}/rate-limit`, {
        method: 'POST',
        body: { device_id: device.id, limit },
      });
      setActiveReq(q);
      setShowLimit(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function applySchedule(windows: { days: number[]; start: string; end: string }[] | null) {
    setOrigin('top');
    setBusy(true);
    setError(null);
    try {
      const q = await api<QueuedRequest>(`/routers/${entry.router_id}/schedule`, {
        method: 'POST',
        body: { device_id: device.id, windows },
      });
      setActiveReq(q);
      setShowSchedule(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const bs = entry.block_state;
  const sees = entry.sees_device;

  return (
    <div className="space-y-3 rounded-[var(--radius-control)] border border-line bg-sunken/50 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Router className="size-4 text-muted" aria-hidden />
          <Link href={`/routers/${entry.router_id}`} className="text-[13px] font-semibold text-fg hover:text-accent-hover hover:underline" dir="auto">
            {entry.name}
          </Link>
          <span className="mono text-xs text-muted">{entry.address}</span>
          <Badge tone={HEALTH_TONE[entry.status]}>{t(`routers.status.${entry.status}` as Key)}</Badge>
          {entry.delivery !== 'active' && (
            <Badge tone={DELIVERY_TONE[entry.delivery]}>{t(`routers.delivery.${entry.delivery}` as Key)}</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {bs.state === 'blocked' ? (
            <Badge tone="crit">
              <Ban className="size-3" aria-hidden />
              {bs.by ? t(`routers.blockedBy.${bs.by}` as Key) : t('routers.client.blocked')}
            </Badge>
          ) : bs.state === 'not_blocked' ? (
            <Badge tone="ok">
              <CheckCircle2 className="size-3" aria-hidden />
              {t('routers.notBlocked')}
            </Badge>
          ) : (
            <Badge tone="idle">{t('routers.blockState.unknown')}</Badge>
          )}
        </div>
      </div>

      {sees ? (
        <dl>
          <Fact label={t('routers.client.connection')}>
            <ConnectionLabel connection={sees.connection} iface={sees.interface} />
          </Fact>
          {sees.signal_dbm !== null && (
            <Fact label={t('routers.client.signal')}>
              <span className="mono">{sees.signal_dbm} dBm</span>
            </Fact>
          )}
          {(sees.lease_remaining_seconds !== null || sees.lease_source) && (
            <Fact label={t('routers.client.lease')}>
              <span>{leaseText(sees.lease_remaining_seconds, sees.lease_source, t)}</span>
            </Fact>
          )}
        </dl>
      ) : (
        <p className="text-xs text-faint">{t('routers.section.notSeen')}</p>
      )}

      {bs.state === 'blocked' && (bs.applied_by_email || bs.applied_at || bs.mechanism) && (
        <div className="rounded-[6px] border border-crit/30 bg-crit/[0.06] px-3 py-2 text-xs text-muted">
          {bs.mechanism && (
            <p className="font-medium text-fg" dir="auto">
              {t('routers.cap.mechanism')}: {bs.mechanism}
            </p>
          )}
          {bs.applied_by_email && bs.applied_at && (
            <p className="mt-0.5" title={absoluteTime(bs.applied_at, locale)}>
              {fill(t('routers.blockedByWho'), {
                who: bs.applied_by_email,
                when: relativeTime(bs.applied_at, locale),
              })}
            </p>
          )}
        </div>
      )}

      {origin === 'top' && (
        <>
          {activeReq && (
            <RequestProgress
              key={activeReq.request_id}
              requestId={activeReq.request_id}
              routerId={entry.router_id}
              collector={activeReq.collector}
              onSettled={() => onChanged()}
            />
          )}
          <RouterErrorNote error={error} routerId={entry.router_id} />
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {bs.state === 'blocked' ? (
          <ActionButton
            action={entry.actions.unblock}
            variant="primary"
            size="sm"
            onRun={() => setDialogAction('unblock')}
          >
            <ShieldOff className="size-3.5" aria-hidden />
            {fill(t('routers.unblockOn'), { router: entry.name })}
          </ActionButton>
        ) : (
          <ActionButton
            action={entry.actions.block}
            variant="danger"
            size="sm"
            onRun={() => setDialogAction('block')}
          >
            <Ban className="size-3.5" aria-hidden />
            {fill(t('routers.blockOn'), { router: entry.name })}
          </ActionButton>
        )}

        <ActionButton
          action={entry.actions.rate_limit}
          variant="secondary"
          size="sm"
          onRun={() => setShowLimit((v) => !v)}
        >
          <Gauge className="size-3.5" aria-hidden />
          {t('routers.section.rateLimit')}
        </ActionButton>

        <ActionButton
          action={entry.actions.schedule}
          variant="secondary"
          size="sm"
          onRun={() => setShowSchedule((v) => !v)}
        >
          <Clock className="size-3.5" aria-hidden />
          {t('routers.section.schedule')}
        </ActionButton>
      </div>

      {showLimit && entry.actions.rate_limit.possible && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void applyLimit({ down_kbps: Number(downKbps) || 0, up_kbps: Number(upKbps) || 0 });
          }}
          className="space-y-3 rounded-[var(--radius-control)] border border-line bg-surface p-3"
        >
          <p className="text-xs text-muted">{t('routers.section.limitHint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('routers.section.down')}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={10000000}
                  className="mono"
                  dir="ltr"
                  value={downKbps}
                  onChange={(e) => setDownKbps(e.target.value)}
                  required
                />
              )}
            </Field>
            <Field label={t('routers.section.up')}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={10000000}
                  className="mono"
                  dir="ltr"
                  value={upKbps}
                  onChange={(e) => setUpKbps(e.target.value)}
                  required
                />
              )}
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="danger" busy={busy} onClick={() => void applyLimit(null)}>
              {t('routers.section.remove')}
            </Button>
            <Button type="submit" size="sm" variant="primary" busy={busy}>
              {t('routers.section.apply')}
            </Button>
          </div>
        </form>
      )}

      {showSchedule && entry.actions.schedule.possible && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void applySchedule([{ days, start: fromTime, end: toTime }]);
          }}
          className="space-y-3 rounded-[var(--radius-control)] border border-line bg-surface p-3"
        >
          <p className="text-xs text-muted">{t('routers.section.scheduleHint')}</p>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">{t('routers.section.days')}</p>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d) => {
                const active = days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()))}
                    className={`h-7 rounded-[5px] border px-2 text-xs font-medium ${active ? 'border-accent bg-accent/15 text-fg' : 'border-line-strong bg-sunken text-muted'}`}
                  >
                    {t(`routers.day.${d}` as Key)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('routers.section.from')}>
              {(id) => (
                <Input
                  id={id}
                  type="time"
                  className="mono"
                  dir="ltr"
                  value={fromTime}
                  onChange={(e) => setFromTime(e.target.value)}
                  required
                />
              )}
            </Field>
            <Field label={t('routers.section.to')}>
              {(id) => (
                <Input
                  id={id}
                  type="time"
                  className="mono"
                  dir="ltr"
                  value={toTime}
                  onChange={(e) => setToTime(e.target.value)}
                  required
                />
              )}
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="danger" busy={busy} onClick={() => void applySchedule(null)}>
              {t('routers.section.remove')}
            </Button>
            <Button type="submit" size="sm" variant="primary" busy={busy} disabled={days.length === 0}>
              {t('routers.section.apply')}
            </Button>
          </div>
        </form>
      )}

      {entry.actions.rename && (
        <RouterSettingsForDevice
          entry={entry}
          busy={busy}
          showRename={showRename}
          setShowRename={setShowRename}
          newName={newName}
          setNewName={setNewName}
          runAction={runAction}
          setConfirm={setConfirm}
          feedback={
            origin === 'settings' ? (
              <>
                {activeReq && (
                  <RequestProgress
                    key={activeReq.request_id}
                    requestId={activeReq.request_id}
                    routerId={entry.router_id}
                    collector={activeReq.collector}
                    onSettled={() => onChanged()}
                  />
                )}
                <RouterErrorNote error={error} routerId={entry.router_id} />
              </>
            ) : null
          }
        />
      )}

      {confirm && (
        <ConfirmModal
          confirm={confirm}
          routerName={entry.name}
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const c = confirm;
            const action =
              c.kind === 'unreserve' ? entry.actions.unreserve : c.kind === 'remove_forward' ? entry.port_forwards?.find((x) => x.id === c.rule.id)?.actions.remove : undefined;
            const ok = await runAction(action);
            setConfirm(null);
            return ok;
          }}
        />
      )}

      {dialogAction && (
        <BlockDialog
          routerId={entry.router_id}
          action={dialogAction}
          devices={[device]}
          onClose={() => setDialogAction(null)}
          onDone={onChanged}
        />
      )}
    </div>
  );
}

/** Router controls for this device beyond blocking: its name on the router, its address reservation, port forwards to it. */
function RouterSettingsForDevice({
  entry,
  busy,
  showRename,
  setShowRename,
  newName,
  setNewName,
  runAction,
  setConfirm,
  feedback,
}: {
  entry: DeviceRouterControls['routers'][number];
  busy: boolean;
  showRename: boolean;
  setShowRename: (v: boolean) => void;
  newName: string;
  setNewName: (v: string) => void;
  runAction: (action: ControlAction | undefined, body?: Record<string, unknown>) => Promise<boolean>;
  setConfirm: (c: Confirm) => void;
  /** Progress and errors of the latest request started from these controls. */
  feedback: React.ReactNode;
}) {
  const { t } = useI18n();
  const a = entry.actions;
  const res = entry.reservation ?? null;
  const settingsRead = a.unreserve?.reason !== 'settings_unknown';
  return (
    <div className="space-y-3 border-t border-line pt-3">
      {feedback}
      {settingsRead && a.reserve && (
        <p className="text-xs text-muted">
          {res ? (
            <>
              {t('routers.res.ip')}: <bdi className="mono text-fg">{res.ip}</bdi>
            </>
          ) : (
            t('routers.res.notReserved')
          )}
        </p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        {a.rename && (
          <ActionButton action={a.rename} size="sm" onRun={() => setShowRename(!showRename)}>
            <Pencil className="size-3.5" aria-hidden />
            {t('routers.rename.button')}
          </ActionButton>
        )}
        {res && a.unreserve && (
          <ActionButton action={a.unreserve} size="sm" busy={busy} onRun={() => setConfirm({ kind: 'unreserve', res })}>
            <PinOff className="size-3.5" aria-hidden />
            {t('routers.action.unreserve')}
          </ActionButton>
        )}
        {a.reserve && a.reserve.reason !== 'already_reserved' && (
          <ActionButton action={a.reserve} size="sm" busy={busy} onRun={() => void runAction(a.reserve)}>
            <Pin className="size-3.5" aria-hidden />
            {t('routers.action.reserve')}
            {a.reserve.body?.ip ? (
              <bdi className="mono">{String(a.reserve.body.ip)}</bdi>
            ) : null}
          </ActionButton>
        )}
      </div>

      {showRename && a.rename?.possible && (
        <form
          className="space-y-2 rounded-[var(--radius-control)] border border-line bg-surface p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await runAction(a.rename, { name: newName.trim() })) setShowRename(false);
          }}
        >
          <Field label={t('routers.rename.title')} hint={t('routers.rename.hint')}>
            {(id) => <Input id={id} value={newName} maxLength={63} required dir="auto" onChange={(e) => setNewName(e.target.value)} />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowRename(false)}>
              {t('routers.cancel')}
            </Button>
            <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!newName.trim()}>
              {t('routers.rename.save')}
            </Button>
          </div>
        </form>
      )}

      {a.port_forward && (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
            <Network className="size-3.5" aria-hidden />
            {t('routers.pf.toDevice')}
          </p>
          {entry.port_forwards && entry.port_forwards.length > 0 ? (
            <div className="rounded-[var(--radius-control)] border border-line bg-surface">
              <PortForwardTable
                rules={entry.port_forwards}
                canAdmin={entry.port_forwards.some((x) => x.actions.remove.possible)}
                busy={busy}
                hideDevice
                onRemove={(rule) => setConfirm({ kind: 'remove_forward', rule })}
              />
            </div>
          ) : entry.port_forwards ? (
            <p className="text-xs text-faint">{t('routers.pf.noneToDevice')}</p>
          ) : null}
          {a.port_forward.possible ? (
            <div className="rounded-[var(--radius-control)] border border-line bg-surface">
              <PortForwardForm deviceId={String(a.port_forward.body?.device_id ?? '')} busy={busy} onSubmit={(body) => runAction(a.port_forward, body)} />
            </div>
          ) : (
            <ActionButton action={a.port_forward} size="sm" onRun={() => undefined}>
              {t('routers.pf.add')}
            </ActionButton>
          )}
        </div>
      )}
    </div>
  );
}
