'use client';

import { useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, Field, Select, useConfirm } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { controlText } from '../control-text';
import type { SwitchControl } from '../control-types';
import { portsText } from '../text';
import { RequestHistory } from './request-history';
import { SnmpCredentialsFields, buildSnmpCredentials, initialCredentialsDraft, snmpCredentialsReady } from './snmp-credentials-fields';
import { DeviceLink } from '@/components/device-link';

/** Switch page → "Port control": write credentials, VLANs read, quarantine VLAN, change history. */
export function SwitchControlCard({ switchId, admin }: { switchId: string; admin: boolean }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  const q = useQuery<SwitchControl>(`/switches/${switchId}/control`, ['devices'], 20_000);
  return (
    <Card title={cx.portControl} padded={false}>
      <Async query={q}>
        {(c) => (
          <div className="space-y-4">
            <div className="space-y-4 px-4 pt-3">
              <p className="text-xs text-muted">{cx.portControlIntro}</p>
              <WriteCredentials c={c} admin={admin} onSaved={q.reload} />
              <div>
                <p className="text-xs font-medium text-fg">
                  {cx.vlans}
                  {c.vlans_read_at && (
                    <span className="ms-1 font-normal text-faint">
                      · {cx.vlansRead} {relativeTime(c.vlans_read_at, locale)} · {c.vlan_methods.map((m) => cx.method[m] ?? m).join(', ')}
                    </span>
                  )}
                </p>
                {c.vlans.length === 0 ? (
                  <p className="mt-1 text-xs text-muted">{cx.vlansNone}</p>
                ) : (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {c.vlans.map((v) => (
                      <li key={v.id}>
                        <Badge tone={v.id === c.effective_quarantine_vlan ? 'warn' : 'idle'} dot={false}>
                          <span className="tnum">{v.id}</span>
                          {v.name && <span dir="auto">· {v.name}</span>}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <QuarantineVlan c={c} admin={admin} onSaved={q.reload} />
              {c.quarantines.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-fg">{cx.quarantined}</p>
                  <ul className="mt-1 space-y-0.5 text-[13px]">
                    {c.quarantines.map((x) => (
                      <li key={x.id}>
                        <DeviceLink id={x.device_id} className="hover:text-accent-hover" dir="auto">
                          {x.device_label}
                        </DeviceLink>{' '}
                        <span className="mono text-xs text-muted">{x.port_name}</span> <Badge tone="warn">{cx.quarantineStatus[x.status] ?? x.status}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div>
              <p className="px-4 text-xs font-medium text-fg">{cx.history}</p>
              <RequestHistory targetId={switchId} />
            </div>
          </div>
        )}
      </Async>
    </Card>
  );
}

function WriteCredentials({ c, admin, onSaved }: { c: SwitchControl; admin: boolean; onSaved: () => void }) {
  const confirm = useConfirm();
  const { locale } = useI18n();
  const cx = controlText(locale);
  const tx = portsText(locale);
  const [open, setOpen] = useState(false);
  const [creds, setCreds] = useState(() => initialCredentialsDraft(c.write.version === '3' ? '3' : '2c'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!snmpCredentialsReady(creds)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/switches/${c.target_id}/write-credentials`, { method: 'PUT', body: { credentials: buildSnmpCredentials(creds) } });
      setOpen(false);
      setCreds(initialCredentialsDraft(creds.version));
      onSaved();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await confirm(cx.removeWriteConfirm, { destructive: true }))) return;
    setError(null);
    try {
      await api(`/switches/${c.target_id}/write-credentials`, { method: 'DELETE' });
      onSaved();
    } catch (err) {
      setError(err as ApiError);
    }
  }

  return (
    <div className="rounded-[var(--radius-control)] border border-line bg-sunken p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-fg">{cx.writeCreds}</p>
          <p className="text-[11px] text-muted">
            {c.write.configured ? (
              <>
                <Badge tone="ok">{cx.writeSet}</Badge> SNMP v{c.write.version} · {relativeTime(c.write.updated_at, locale)}
              </>
            ) : (
              cx.writeNotSet
            )}
          </p>
        </div>
        {admin && !open && (
          <span className="flex gap-1">
            <Button size="sm" onClick={() => setOpen(true)}>
              {c.write.configured ? cx.replaceWrite : cx.enterWrite}
            </Button>
            {c.write.configured && (
              <Button size="sm" variant="ghost" onClick={remove}>
                {cx.removeWrite}
              </Button>
            )}
          </span>
        )}
      </div>
      {open && (
        <form onSubmit={save} className="mt-3 space-y-3">
          <p className="text-[11px] text-muted">{cx.writeCredsHint}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <SnmpCredentialsFields value={creds} onChange={setCreds} tx={{ ...tx, community: cx.writeCommunity, communityHint: tx.communityHint }} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {cx.cancel}
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!snmpCredentialsReady(creds)}>
              {cx.saveWrite}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}

function QuarantineVlan({ c, admin, onSaved }: { c: SwitchControl; admin: boolean; onSaved: () => void }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  const [value, setValue] = useState(c.quarantine_vlan === null ? '' : String(c.quarantine_vlan));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = value !== (c.quarantine_vlan === null ? '' : String(c.quarantine_vlan));

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/switches/${c.target_id}/quarantine-vlan`, { method: 'PUT', body: { vlan: value ? Number(value) : null } });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const siteLabel = `${cx.useSite} (${c.site_quarantine_vlan ?? cx.siteNone})`;
  if (!admin) {
    return (
      <p className="text-xs text-muted">
        {cx.quarantineVlan}: {c.quarantine_vlan ?? siteLabel}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[220px] flex-1">
        <Field label={cx.quarantineVlanSwitch} hint={cx.quarantineVlanSwitchHint}>
          {(id) => (
            <Select id={id} value={value} onChange={(e) => (setValue(e.target.value), setSaved(false))} disabled={c.vlans.length === 0 && c.quarantine_vlan === null}>
              <option value="">{siteLabel}</option>
              {c.vlans.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                  {v.name ? ` · ${v.name}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Button size="sm" busy={busy} disabled={!changed} onClick={save}>
        {cx.save}
      </Button>
      {saved && <span className="text-xs text-ok">{cx.saved}</span>}
      {error && (
        <div className="w-full">
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}
