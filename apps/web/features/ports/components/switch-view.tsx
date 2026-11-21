'use client';

import type { SwitchDetail } from '@lan-detective/shared-types';
import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, Field, Input, Modal, Switch } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { STATUS_TONE } from './port-tones';
import { PortRow } from './port-row';
import { SwitchControlCard } from './switch-control';
import {
  SnmpCredentialsFields,
  buildSnmpCredentials,
  initialCredentialsDraft,
  snmpCredentialsReady,
} from './snmp-credentials-fields';
import { portsText } from '../text';

export function SwitchView({
  id,
  admin,
  canPoll,
  onRemoved,
  onUpdated,
}: {
  id: string;
  admin: boolean;
  canPoll: boolean;
  onRemoved: () => void;
  onUpdated?: () => void;
}) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const q = useQuery<SwitchDetail>(`/switches/${id}`, ['devices'], 20_000);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(noteTimer.current), []);

  async function readNow() {
    setBusy(true);
    setError(null);
    try {
      await api(`/switches/${id}/poll`, { method: 'POST' });
      setNote(tx.queued);
      clearTimeout(noteTimer.current);
      noteTimer.current = setTimeout(() => setNote(null), 8000);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm(tx.removeConfirm)) return;
    setError(null);
    try {
      await api(`/switches/${id}`, { method: 'DELETE' });
      onRemoved();
    } catch (e) {
      setError(e as ApiError);
    }
  }

  return (
    <Async query={q}>
      {(s) => (
        <>
          <Card
            padded={false}
            title={
              <span dir="auto">
                {s.name} <span className="mono text-xs font-normal text-muted">{s.host}</span>
              </span>
            }
            action={
              <span className="flex gap-1">
                {canPoll && (
                  <Button size="sm" busy={busy} onClick={readNow}>
                    <RefreshCw className="size-3.5" aria-hidden />
                    {tx.readNow}
                  </Button>
                )}
                {admin && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={tx.edit}>
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={remove} aria-label={tx.remove}>
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </span>
            }
          >
            <div className="space-y-1 px-4 pt-3 text-xs text-muted">
              <p>
                <Badge tone={STATUS_TONE[s.last_status]}>{tx.status[s.last_status]}</Badge>{' '}
                {s.last_ok_at && (
                  <span>
                    {tx.lastRead}: {relativeTime(s.last_ok_at, locale)}
                  </span>
                )}
                {s.sys_descr && <span className="ms-2 text-faint" dir="auto">{s.sys_descr}</span>}
              </p>
              {s.last_status === 'error' && s.last_error && <p className="text-crit">{s.last_error}</p>}
              {!s.in_scope && <p className="text-warn">{tx.outOfScope}</p>}
              {s.truncated.length > 0 && <p className="text-warn">{tx.truncated}</p>}
              {note && <p className="text-ok">{note}</p>}
              {error && <ErrorNote error={error} />}
            </div>
            {s.ports.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[820px] text-start text-[13px]">
                  <thead>
                    <tr className="border-y border-line text-xs text-muted">
                      <th scope="col" className="px-4 py-2 text-start font-medium">{tx.port}</th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">{tx.state}</th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">{tx.connected}</th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">{tx.traffic}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{tx.errors}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {s.ports.map((p) => (
                      <PortRow key={p.if_index} p={p} switchId={s.id} admin={admin} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <SwitchControlCard switchId={s.id} admin={admin} />
          {editing && (
            <EditSwitchModal
              sw={s}
              onClose={() => setEditing(false)}
              onSaved={() => {
                q.reload();
                onUpdated?.();
              }}
            />
          )}
        </>
      )}
    </Async>
  );
}

function EditSwitchModal({
  sw,
  onClose,
  onSaved,
}: {
  sw: SwitchDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { locale, t } = useI18n();
  const tx = portsText(locale);
  const [name, setName] = useState(sw.name);
  const [host, setHost] = useState(sw.host);
  const [pollInterval, setPollInterval] = useState(String(sw.poll_interval_seconds));
  const [enabled, setEnabled] = useState(sw.enabled);
  const [rotateCreds, setRotateCreds] = useState(false);
  const [creds, setCreds] = useState(() => initialCredentialsDraft(sw.version));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const intervalNum = Number(pollInterval);
  const intervalValid = Number.isInteger(intervalNum) && intervalNum >= 60 && intervalNum <= 86400;
  const ready = Boolean(host.trim() && intervalValid && (!rotateCreds || snmpCredentialsReady(creds)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/switches/${sw.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim() || null,
          ...(host.trim() !== sw.host ? { host: host.trim() } : {}),
          poll_interval_seconds: intervalNum,
          enabled,
          ...(rotateCreds ? { credentials: buildSnmpCredentials(creds) } : {}),
        },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${tx.editTitle} · ${sw.name}`} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-4">
        <Field label={tx.name}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.host} hint={tx.hostHint}>
            {(id) => <Input id={id} dir="ltr" className="mono" value={host} onChange={(e) => setHost(e.target.value)} required maxLength={15} />}
          </Field>
          <Field label={tx.pollInterval} hint={tx.pollIntervalHint}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={60}
                max={86400}
                dir="ltr"
                className="mono"
                value={pollInterval}
                onChange={(e) => setPollInterval(e.target.value)}
                required
              />
            )}
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line bg-sunken px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-fg">{tx.enabled}</p>
            <p className="text-[11px] text-muted">{tx.enabledHint}</p>
          </div>
          <Switch checked={enabled} onChange={setEnabled} label={tx.enabled} />
        </div>
        <div className="rounded-[var(--radius-control)] border border-line bg-sunken p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-fg">{tx.replaceCredentials}</p>
              <p className="text-[11px] text-muted">{tx.replaceCredentialsHint}</p>
            </div>
            <Switch checked={rotateCreds} onChange={setRotateCreds} label={tx.replaceCredentials} />
          </div>
          {rotateCreds && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <SnmpCredentialsFields value={creds} onChange={setCreds} tx={tx} />
            </div>
          )}
        </div>
        {error && <ErrorNote error={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {tx.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
