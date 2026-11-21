'use client';

import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Button, DataTable, EmptyState, ErrorNote, Field, Input, Modal, Select } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import type { Expected, ExpectedKind } from '../types';

const KINDS: ExpectedKind[] = ['dhcp_server', 'wifi_bssid', 'upnp_mapping'];

/** What administrators approved for this site ("this is expected"), with withdraw and add. */
export function ExpectedList({ siteId, items, onChanged }: { siteId: string; items: Expected[]; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const admin = can('admin');
  const [removing, setRemoving] = useState<Expected | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<ExpectedKind>('dhcp_server');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = async (fn: () => Promise<unknown>, done: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      done();
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {!admin && <p className="px-4 pt-3 text-xs text-muted">{t('security.exp.adminOnly')}</p>}
      {items.length === 0 ? (
        <EmptyState icon={<CheckCircle2 />} title={t('security.exp.none')}>
          <p>{t('security.exp.noneHint')}</p>
        </EmptyState>
      ) : (
        <DataTable stack>
          <thead>
            <tr>
              <th>{t('security.exp.kind')}</th>
              <th>{t('security.exp.value')}</th>
              <th>{t('security.exp.note')}</th>
              <th>{t('security.exp.added')}</th>
              {admin && <th aria-label={t('security.exp.remove')} />}
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td data-label={t('security.exp.kind')}>{t(`security.exp.kind.${e.kind}` as Key)}</td>
                <td data-label={t('security.exp.value')}>
                  <span className="mono break-all text-xs" dir="ltr">
                    {e.value}
                  </span>
                </td>
                <td data-label={t('security.exp.note')} dir="auto">
                  {e.note ?? '—'}
                </td>
                <td data-label={t('security.exp.added')} title={absoluteTime(e.created_at, locale)}>
                  {relativeTime(e.created_at, locale)}
                </td>
                {admin && (
                  <td>
                    <Button size="sm" variant="danger" onClick={() => (setError(null), setRemoving(e))}>
                      {t('security.exp.remove')}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {admin && (
        <div className="px-4 pb-4">
          {adding ? (
            <div className="space-y-3 rounded-[var(--radius-control)] border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                <Field label={t('security.exp.kind')}>
                  {(id) => (
                    <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as ExpectedKind)}>
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {t(`security.exp.kind.${k}` as Key)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={t('security.exp.value')} hint={t(`security.exp.valueHint.${kind}` as Key)}>
                  {(id) => <Input id={id} dir="ltr" className="mono" maxLength={120} value={value} onChange={(e) => setValue(e.target.value)} />}
                </Field>
              </div>
              <Field label={t('security.f.note')}>{(id) => <Input id={id} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              <ErrorNote error={error} />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setAdding(false)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={!value.trim()}
                  onClick={() =>
                    void run(
                      () => api('/security/expected', { method: 'POST', body: { site_id: siteId, kind, value: value.trim(), ...(note.trim() ? { note: note.trim() } : {}) } }),
                      () => (setAdding(false), setValue(''), setNote('')),
                    )
                  }
                >
                  {t('common.add')}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" onClick={() => (setError(null), setAdding(true))}>
              {t('security.exp.add')}
            </Button>
          )}
        </div>
      )}
      {removing && (
        <Modal title={t('security.exp.removeTitle')} onClose={() => setRemoving(null)}>
          <div className="space-y-3">
            <p className="text-[13px] text-fg">{fill(t('security.exp.removeConfirm'), { value: removing.value })}</p>
            <ErrorNote error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" busy={busy} onClick={() => void run(() => api(`/security/expected/${removing.id}`, { method: 'DELETE' }), () => setRemoving(null))}>
                {t('security.exp.remove')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
