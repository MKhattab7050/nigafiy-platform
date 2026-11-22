'use client';

import { useState } from 'react';
import type { MonitoringCheck } from '@lan-detective/shared-types';
import { Button, ErrorNote, Field, Input, Modal } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { type Key, useI18n } from '@/lib/i18n';
import { type WatchDraft, WatchFields, buildConfig, draftFromCheck, isWatchKind } from './watch-fields';

/**
 * Name, interval and thresholds of an existing check (PATCH /checks/:id). Kind, target, port and the
 * SNMP device stay as created; the settings of a watch check (path, status, body assertion, TLS,
 * certificate thresholds, OID and thresholds) are edited and re-validated by the API as a whole.
 */
export function EditCheck({ check, onClose, onSaved }: { check: MonitoringCheck; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: check.name,
    interval_seconds: String(check.interval_seconds),
    failure_threshold: String(check.failure_threshold),
    latency_warn_ms: check.latency_warn_ms === null ? '' : String(check.latency_warn_ms),
    loss_warn_pct: check.loss_warn_pct === null ? '' : String(check.loss_warn_pct),
  });
  const [draft, setDraft] = useState<WatchDraft>(() => draftFromCheck(check));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const watch = isWatchKind(check.kind);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    setBusy(true);
    setError(null);
    try {
      await api<MonitoringCheck>(`/checks/${check.id}`, {
        method: 'PATCH',
        body: {
          name: form.name.trim(),
          interval_seconds: Number(form.interval_seconds),
          failure_threshold: Number(form.failure_threshold),
          latency_warn_ms: num(form.latency_warn_ms),
          ...(check.kind === 'icmp' ? { loss_warn_pct: num(form.loss_warn_pct) } : {}),
          ...(isWatchKind(check.kind) ? { config: buildConfig(check.kind, draft, draft.path) } : {}),
        },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('monitoring.editCheck')} onClose={onClose} wide={watch}>
      <form onSubmit={save} className="space-y-3.5">
        <Field label={t('common.name')}>{(id) => <Input id={id} value={form.name} onChange={set('name')} required maxLength={80} />}</Field>
        <p className="text-xs text-muted">
          {t(`monitoring.kind.${check.kind}` as Key)} ·{' '}
          <span className="mono" dir="ltr">
            {check.target}
            {check.port ? `:${check.port}` : ''}
          </span>
        </p>
        {isWatchKind(check.kind) && <WatchFields kind={check.kind} draft={draft} onChange={setDraft} siteId={check.site_id} mode="edit" />}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('monitoring.interval')}>{(id) => <Input id={id} type="number" min={15} max={3600} required dir="ltr" value={form.interval_seconds} onChange={set('interval_seconds')} />}</Field>
          <Field label={t('monitoring.threshold')}>{(id) => <Input id={id} type="number" min={1} max={20} required dir="ltr" value={form.failure_threshold} onChange={set('failure_threshold')} />}</Field>
          <Field label={t('monitoring.latencyWarn')}>{(id) => <Input id={id} type="number" min={1} max={60000} dir="ltr" value={form.latency_warn_ms} onChange={set('latency_warn_ms')} />}</Field>
          {check.kind === 'icmp' && (
            <Field label={t('monitoring.lossWarn')}>{(id) => <Input id={id} type="number" min={0} max={100} dir="ltr" value={form.loss_warn_pct} onChange={set('loss_warn_pct')} />}</Field>
          )}
        </div>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!form.name.trim()}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
