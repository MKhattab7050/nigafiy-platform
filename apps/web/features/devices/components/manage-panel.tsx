'use client';

import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEVICE_TYPES, type DeviceDetail } from '@lan-detective/shared-types';
import { Button, ErrorNote, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { DEVICE_TYPE_LABEL } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export function ManagePanel({ device, onSaved }: { device: DeviceDetail; onSaved: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const [form, setForm] = useState({ display_name: '', device_type: 'unknown', owner: '', notes: '', tags: '', is_critical: false });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);

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

  // When the type changes on the server (reset to automatic, re-classified), follow it so a save does not send the old type back.
  useEffect(() => {
    setForm((f) => ({ ...f, device_type: device.device_type }));
  }, [device.device_type, device.type_source]);

  async function resetType() {
    setResetting(true);
    setError(null);
    try {
      await api(`/devices/${device.id}`, { method: 'PATCH', body: { device_type: null } });
      setResetDone(true);
      onSaved();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setResetting(false);
    }
  }

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
      {device.type_source === 'manual' && (
        <div className="space-y-1.5">
          <Button size="sm" variant="ghost" busy={resetting} onClick={() => void resetType()}>
            <RotateCcw className="size-3.5" aria-hidden />
            {t('device.resetType')}
          </Button>
          <p className="text-xs text-faint">{t('device.resetTypeHint')}</p>
        </div>
      )}
      {resetDone && device.type_source !== 'manual' && <Notice>{t('device.resetTypeDone')}</Notice>}
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
