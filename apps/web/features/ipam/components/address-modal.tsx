'use client';

import type { IpamHistoryEntry, IpamRecordKind, IpamSubnetDetail } from '@lan-detective/shared-types';
import { useState } from 'react';
import { Badge, Button, ErrorNote, Fact, Field, Input, Modal, Select, Spinner, StatusBadge } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ipamText } from '../text';
import { parseIp } from '../subnet-calc';
import { DeviceLink } from '@/components/device-link';

// ── one address: what is observed, what is documented, who used it ──────────

type Props = { subnet: IpamSubnetDetail; ip: string; onClose: () => void; onChanged: () => void };

export function AddressModal(props: Props) {
  return props.subnet.family === 6 ? <AddressModal6 {...props} /> : <AddressDialog {...props} entry={props.subnet.addresses.find((a) => a.ip === props.ip) ?? null} />;
}

/** An IPv6 subnet's address list is paged: the address may be on another page, so it is loaded on its own first. */
function AddressModal6(props: Props) {
  const single = useQuery<IpamSubnetDetail>(`/ipam/subnets/${props.subnet.id}${qs({ ip: props.ip })}`, [], 0);
  if (!single.data) {
    return (
      <Modal title={props.ip} onClose={props.onClose} wide>
        {single.error ? <ErrorNote error={single.error} /> : <Spinner />}
      </Modal>
    );
  }
  return <AddressDialog {...props} entry={single.data.addresses.find((a) => a.ip === props.ip) ?? null} />;
}

function AddressDialog({ subnet, ip, entry, onClose, onChanged }: Props & { entry: IpamSubnetDetail['addresses'][number] | null }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const { can } = useApp();
  const record = entry?.record ?? null;
  const editable = can('technician');
  const history = useQuery<{ items: IpamHistoryEntry[] }>(`/ipam/history${qs({ site_id: subnet.site_id, ip })}`, ['devices'], 60_000);

  const [kind, setKind] = useState<IpamRecordKind>(record?.kind ?? 'static');
  const [label, setLabel] = useState(record?.label ?? '');
  const [mac, setMac] = useState(record?.mac ?? '');
  const [notes, setNotes] = useState(record?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const observedMac = entry?.devices.find((d) => d.mac)?.mac ?? null;
  const n = parseIp(ip)?.value;
  const pool = subnet.dhcp ? { start: parseIp(subnet.dhcp.start)?.value, end: parseIp(subnet.dhcp.end)?.value } : null;
  const inPool = n !== undefined && pool?.start !== undefined && pool.end !== undefined && n >= pool.start && n <= pool.end;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      onClose();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  }
  const save = () =>
    run(() => {
      const body = { kind, label: label.trim(), mac: kind === 'reserved' ? null : mac.trim() || null, notes: notes.trim() || null };
      return record ? api(`/ipam/addresses/${record.id}`, { method: 'PATCH', body }) : api('/ipam/addresses', { method: 'POST', body: { site_id: subnet.site_id, ip, ...body } });
    });
  const ready = label.trim().length > 0 && (kind !== 'dhcp_reservation' || mac.trim().length > 0);

  return (
    <Modal title={ip} onClose={onClose} wide>
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted">
            {tx.observed}
            {entry?.flags.map((f) => (
              <Badge key={f} tone="info" dot={false}>
                {tx.flag[f]}
              </Badge>
            ))}
            {!entry && inPool && (
              <Badge tone="info" dot={false}>
                {tx.flag.dhcp_pool}
              </Badge>
            )}
          </h3>
          {entry && entry.devices.length > 0 ? (
            <ul className="space-y-1.5">
              {entry.devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <StatusBadge status={d.status} />
                  <DeviceLink id={d.id} className="font-medium hover:text-accent-hover" dir="auto">
                    {d.label}
                  </DeviceLink>
                  {d.mac && <span className="mono text-xs text-muted">{d.mac}</span>}
                  <span className="text-xs text-faint">
                    {tx.lastSeen} {relativeTime(d.last_seen_at, locale)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">{entry?.record || entry?.flags.length ? tx.observedNone : tx.observedFree}</p>
          )}
          {entry?.conflict && (
            <div role="alert" className="mt-3 rounded-md border border-crit/30 bg-crit/10 px-3 py-2 text-[13px]">
              <p className="font-medium">{tx.conflictKind[entry.conflict]}</p>
              <p className="mt-0.5 text-xs text-muted">{tx.conflictHelp[entry.conflict]}</p>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted">{record ? tx.documented : tx.document}</h3>
          {editable ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={tx.fieldKind} hint={tx.kindHint[kind]}>
                {(id) => (
                  <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as IpamRecordKind)}>
                    {(['static', 'dhcp_reservation', 'reserved'] as const).map((k) => (
                      <option key={k} value={k}>
                        {tx.kind[k]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={tx.fieldLabel}>{(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />}</Field>
              {kind !== 'reserved' && (
                <div className="sm:col-span-2">
                  <Field label={tx.fieldMac} hint={kind === 'dhcp_reservation' ? tx.fieldMacRequired : tx.fieldMacHint}>
                    {(id) => (
                      <div className="flex gap-2">
                        <Input id={id} dir="ltr" className="mono" value={mac} onChange={(e) => setMac(e.target.value)} placeholder="00:11:22:33:44:55" maxLength={17} spellCheck={false} />
                        {observedMac && observedMac !== mac.trim().toLowerCase() && (
                          <Button className="h-9" onClick={() => setMac(observedMac)}>
                            {tx.useObserved}
                          </Button>
                        )}
                      </div>
                    )}
                  </Field>
                </div>
              )}
              <div className="sm:col-span-2">
                <Field label={tx.fieldNotes}>{(id) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />}</Field>
              </div>
            </div>
          ) : record ? (
            <dl>
              <Fact label={tx.fieldKind}>{tx.kind[record.kind]}</Fact>
              <Fact label={tx.fieldLabel}>
                <span dir="auto">{record.label}</span>
              </Fact>
              {record.mac && (
                <Fact label={tx.fieldMac}>
                  <span className="mono">{record.mac}</span>
                </Fact>
              )}
              {record.notes && (
                <Fact label={tx.fieldNotes}>
                  <span dir="auto">{record.notes}</span>
                </Fact>
              )}
            </dl>
          ) : (
            <p className="text-[13px] text-muted">{tx.readOnly}</p>
          )}
          {error && (
            <div className="mt-3">
              <ErrorNote error={error} />
            </div>
          )}
          {editable && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" busy={busy} disabled={!ready} onClick={save}>
                {tx.save}
              </Button>
              {record && (
                <Button variant="danger" disabled={busy} onClick={() => run(() => api(`/ipam/addresses/${record.id}`, { method: 'DELETE' }))}>
                  {tx.remove}
                </Button>
              )}
              <Button variant="ghost" onClick={onClose}>
                {tx.cancel}
              </Button>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted">{tx.history}</h3>
          {history.data && history.data.items.length === 0 && <p className="text-[13px] text-muted">{tx.historyNone}</p>}
          <ul className="divide-y divide-line text-[13px]">
            {history.data?.items.map((h) => (
              <li key={h.device_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <DeviceLink id={h.device_id} className="font-medium hover:text-accent-hover" dir="auto">
                  {h.label}
                </DeviceLink>
                {h.mac && <span className="mono text-xs text-muted">{h.mac}</span>}
                <span className="ms-auto text-xs text-faint">
                  {relativeTime(h.first_seen_at, locale)} → {h.current ? tx.now : relativeTime(h.last_seen_at, locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}
