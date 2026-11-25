'use client';

import { useState } from 'react';
import { Async, Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, Notice, Select, SkeletonBlock, Textarea, type Tone } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import type { DeviceIdentity, Diff, Restore, RestorePreview, Version } from '../types';
import { DiffView } from './diff-view';

// Administrator-confirmed restore (API modules/configbackup/restore.ts): the diff from the latest
// backup, the typed device name and a reason, the device identity (a version from another device needs
// a second typed confirmation); an honest "not supported" with the vendor's reason for every vendor
// without an automatic device-side rollback. The configuration never reaches the browser unsanitized.

const STATUS_TONE: Record<Restore['status'], Tone> = { pre_backup: 'info', pending: 'info', verified: 'ok', failed: 'crit', rolled_back: 'warn', expired: 'warn' };
const MINUTES = [1, 2, 3, 5, 10];
const KNOWN_BLOCKS = new Set([
  'restore_unsupported',
  'restore_vendor_unknown',
  'host_key_not_pinned',
  'raw_copy_missing',
  'already_current',
  'restore_in_progress',
  'backup_in_progress',
  'no_collector',
  'device_identity_mismatch',
  'device_identity_unknown',
]);

/** Drivers whose "not supported" reason is translated (cb.r.unsupported.<driver>). */
const UNSUPPORTED_WHY = new Set(['cisco_nxos', 'cisco_asa', 'aruba_procurve', 'aruba_aoscx', 'mikrotik_routeros', 'fortinet_fortios', 'huawei_vrp', 'dell_os10', 'dell_os6', 'paloalto_panos']);

function blockText(b: { code: string; message: string }, t: (k: Key) => string): string {
  if (KNOWN_BLOCKS.has(b.code)) return t(`cb.r.block.${b.code}` as Key);
  // backup_<readiness>: the same hint the status card shows.
  if (b.code.startsWith('backup_')) return t(`cb.readyHint.${b.code.slice('backup_'.length)}` as Key);
  return b.message;
}

function identityText(d: DeviceIdentity, t: (k: Key) => string): string {
  const parts = [d.model && fill(t('cb.r.identityModel'), { model: ltr(d.model) }), d.serial && fill(t('cb.r.identitySerial'), { serial: ltr(d.serial) })].filter(Boolean);
  return parts.length ? parts.join(', ') : t('cb.r.identityNone');
}

export function RestoreDialog({ targetId, version, onClose, onDone }: { targetId: string; version: Version; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  // Fetched only when an administrator opens the dialog (the preview reads content and is audited).
  const query = useQuery<RestorePreview>(`/config-backup/targets/${targetId}/restore-preview${qs({ version_id: version.id })}`, [], 0);
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(5);
  const [otherDevice, setOtherDevice] = useState(false);
  const [otherConfirm, setOtherConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (forced: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api<Restore>(`/config-backup/targets/${targetId}/restore`, {
        method: 'POST',
        body: { version_id: version.id, confirm, reason, confirm_minutes: minutes, ...(forced ? { allow_other_device: true, confirm_other_device: otherConfirm } : {}) },
      });
      onDone();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={fill(t('cb.r.title'), { n: version.number })} onClose={onClose} wide>
      <Async query={query} skeleton={<SkeletonBlock lines={8} />}>
        {(p) => {
          if (!p.supported || !p.possible) {
            return (
              <div className="space-y-3">
                <p className="text-sm font-medium">{p.supported ? t('cb.r.blocked') : t('cb.r.notSupported')}</p>
                <p className="text-[13px] text-muted">{p.blocker ? blockText(p.blocker, t) : ''}</p>
                {!p.supported && p.driver && UNSUPPORTED_WHY.has(p.driver) && (
                  <p className="text-[13px] text-muted">{fill(t('cb.r.unsupportedWhy'), { why: t(`cb.r.unsupported.${p.driver}` as Key) })}</p>
                )}
                <div className="flex justify-end">
                  <Button onClick={onClose}>{t('common.close')}</Button>
                </div>
              </div>
            );
          }
          const diff: Diff | null = p.current ? { from: p.current, to: p.version, identical: p.identical, added: p.added, removed: p.removed, approximate: p.approximate, truncated: p.truncated, hunks: p.hunks } : null;
          const vyos = p.method === 'vyos_commit_confirm';
          const owrt = p.method === 'openwrt_uci_apply_rollback';
          const mismatch = p.identity.check !== 'match';
          const forcedOk = !mismatch || (otherDevice && otherConfirm.trim() === p.other_device_confirm_text);
          const ok = confirm.trim() === p.confirm_text && reason.trim().length >= 10 && forcedOk;
          return (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (ok) void submit(mismatch);
              }}
            >
              <Notice>{fill(t(owrt ? 'cb.r.introOpenwrt' : vyos ? 'cb.r.introVyos' : 'cb.r.intro'), { n: p.version.number })}</Notice>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-fg/85">{t('cb.r.identity')}</p>
                <p className="text-[13px] text-muted">{fill(t('cb.r.identityVersion'), { n: ltr(p.version.number), id: identityText(p.identity.version, t) })}</p>
                <p className="text-[13px] text-muted">{fill(t('cb.r.identityDevice'), { id: identityText(p.identity.device, t) })}</p>
                {mismatch ? (
                  <div className="space-y-2 rounded-[var(--radius-control)] border border-crit/40 p-3">
                    <p className="text-[13px] text-crit">{p.other_device_block ? blockText(p.other_device_block, t) : ''}</p>
                    <label className="inline-flex items-center gap-2 text-[13px]">
                      <input type="checkbox" className="size-3.5 accent-[var(--color-accent)]" checked={otherDevice} onChange={(e) => setOtherDevice(e.target.checked)} />
                      {t('cb.r.otherDevice')}
                    </label>
                    {otherDevice && (
                      <Field label={t('cb.r.otherDeviceConfirm')} hint={fill(t('cb.r.confirmHint'), { name: ltr(p.other_device_confirm_text ?? '') })}>
                        {(id) => <Input id={id} dir="ltr" autoComplete="off" value={otherConfirm} onChange={(e) => setOtherConfirm(e.target.value)} />}
                      </Field>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-ok">{t('cb.r.identityMatch')}</p>
                )}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-fg/85">{t('cb.r.diffTitle')}</p>
                {diff && !diff.identical ? (
                  <DiffView diff={diff} downloadHref={`/api/v1/config-backup/targets/${targetId}/diff${qs({ from: diff.from.id, to: diff.to.id, format: 'unified' })}`} />
                ) : (
                  <p className="text-[13px] text-muted">{t('cb.r.identical')}</p>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('cb.r.confirm')} hint={fill(t('cb.r.confirmHint'), { name: ltr(p.confirm_text) })}>
                  {(id) => <Input id={id} dir="auto" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
                </Field>
                <Field label={t('cb.r.minutes')} hint={t(owrt ? 'cb.r.minutesHintOpenwrt' : vyos ? 'cb.r.minutesHintVyos' : 'cb.r.minutesHint')}>
                  {(id) => (
                    <Select id={id} value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>
                      {MINUTES.map((m) => (
                        <option key={m} value={m}>
                          {fill(t('cb.r.minutesValue'), { n: ltr(m) })}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              <Field label={t('cb.r.reason')} hint={t('cb.r.reasonHint')}>
                {(id) => <Textarea id={id} dir="auto" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
              </Field>
              <ErrorNote error={error} />
              <div className="flex justify-end gap-2">
                <Button type="button" onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" variant="danger" busy={busy} disabled={!ok}>
                  {t('cb.r.submit')}
                </Button>
              </div>
            </form>
          );
        }}
      </Async>
    </Modal>
  );
}

/** Every restore of this device with its outcome and the steps the collector reported. */
export function RestoreHistory({ targetId }: { targetId: string }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const query = useQuery<{ items: Restore[] }>(`/config-backup/targets/${targetId}/restores`, ['devices'], 15_000);
  return (
    <Card title={t('cb.r.history')} padded={false}>
      {!can('admin') && <p className="border-b border-line px-4 py-2.5 text-xs text-muted">{t('cb.r.adminOnly')}</p>}
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted">{t('cb.r.none')}</p>
          ) : (
            <DataTable stack>
              <thead>
                <tr>
                  <th>{t('cb.status')}</th>
                  <th>{t('cb.v.number')}</th>
                  <th>{t('cb.r.reason')}</th>
                  <th>{t('cb.r.steps')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td data-label={t('cb.status')}>
                      <Badge tone={STATUS_TONE[r.status]}>{t(`cb.r.status.${r.status}` as Key)}</Badge>
                      <span className="block text-xs text-faint" title={absoluteTime(r.created_at, locale)} dir="auto">
                        {relativeTime(r.created_at, locale)}
                        {r.requested_by_email ? ` · ${fill(t('cb.r.by'), { who: ltr(r.requested_by_email) })}` : ''}
                      </span>
                    </td>
                    <td data-label={t('cb.v.number')} className="tnum">
                      {fill(t('cb.r.version'), { n: ltr(r.version_number) })}
                      <span className="block text-xs text-faint">
                        {[r.committed && t('cb.r.committed'), r.confirmed && t('cb.r.confirmed'), r.rolled_back && t('cb.r.rolledBack'), r.forced_other_device && t('cb.r.forced')]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </td>
                    <td data-label={t('cb.r.reason')} className="text-[13px]" dir="auto">
                      {r.reason}
                      {r.error && (
                        <span className="block text-xs text-crit" dir="auto">
                          {r.error}
                        </span>
                      )}
                    </td>
                    <td data-label={t('cb.r.steps')}>
                      {r.steps.length ? (
                        <ol className="mono list-decimal space-y-0.5 ps-4 text-xs text-muted" dir="ltr">
                          {r.steps.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ol>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )
        }
      </Async>
    </Card>
  );
}
