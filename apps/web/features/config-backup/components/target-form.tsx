'use client';

import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, Notice, Select, Switch } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { fill, useI18n } from '@/lib/i18n';
import type { Driver, Target } from '../types';
import { CredentialFields, type CredentialDraft, EMPTY_CREDENTIALS, credentialsBody, fieldErrors } from './credentials-form';

/** What happened right after adding a device; the target page shows the matching sentence. */
export type AddedCode = 'queued' | 'noCollector' | 'noCreds';
export const ADDED_CODES: AddedCode[] = ['queued', 'noCollector', 'noCreds'];

export const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function DriverSelect({ id, value, onChange, drivers, disabled }: { id: string; value: string | null; onChange: (v: string | null) => void; drivers: Driver[]; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <Select id={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t('cb.form.vendorAuto')}</option>
      {drivers.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </Select>
  );
}

export interface AddPrefill {
  address?: string;
  name?: string | null;
  suggestedDriver?: { driver: string | null; name: string | null } | null;
}

/** Add a device by address (or from a suggestion). Credentials are optional here and write-only. */
export function AddTargetForm({
  siteId,
  timezone,
  drivers,
  prefill,
  onDone,
  onCancel,
}: {
  siteId: string;
  timezone: string;
  drivers: Driver[];
  prefill?: AddPrefill;
  onDone: (result: { id: string; added: AddedCode }) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [address, setAddress] = useState(prefill?.address ?? '');
  const [port, setPort] = useState(22);
  const [name, setName] = useState(prefill?.name ?? '');
  const [driver, setDriver] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<'daily' | 'off'>('daily');
  const [hour, setHour] = useState(2);
  const [withCreds, setWithCreds] = useState(false);
  const [creds, setCreds] = useState<CredentialDraft>(EMPTY_CREDENTIALS);
  const [runNow, setRunNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const credBody = withCreds ? credentialsBody(creds) : null;
  const errors = fieldErrors(error);
  const suggestion = prefill?.suggestedDriver?.driver ? prefill.suggestedDriver : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        site_id: siteId,
        targets: [{ address: address.trim(), port, ...(name.trim() ? { name: name.trim() } : {}), driver }],
        ...(credBody ? { credentials: credBody } : {}),
        schedule,
        schedule_hour: hour,
        run_now: Boolean(credBody) && runNow,
      };
      const r = await api<{ items: Target[]; queued: unknown[]; no_collector: boolean }>('/config-backup/targets', { method: 'POST', body });
      const added: AddedCode = !credBody ? 'noCreds' : r.queued.length ? 'queued' : r.no_collector ? 'noCollector' : 'noCreds';
      setCreds(EMPTY_CREDENTIALS);
      onDone({ id: r.items[0]!.id, added });
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('cb.addDevice')}>
      <form
        autoComplete="off"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_1fr]">
          <Field label={t('cb.form.address')} error={errors['targets.0.address']}>
            {(id) => <Input id={id} dir="ltr" className="mono" required placeholder="192.168.1.1" value={address} onChange={(e) => setAddress(e.target.value)} />}
          </Field>
          <Field label={t('cb.form.port')} error={errors['targets.0.port']}>
            {(id) => <Input id={id} type="number" dir="ltr" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />}
          </Field>
          <Field label={t('cb.form.name')} hint={t('cb.form.nameHint')} error={errors['targets.0.name']}>
            {(id) => <Input id={id} dir="auto" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        </div>
        <Field label={t('cb.form.vendor')} hint={t('cb.form.vendorHint')} error={errors['targets.0.driver']}>
          {(id) => <DriverSelect id={id} value={driver} onChange={setDriver} drivers={drivers} />}
        </Field>
        {suggestion && driver !== suggestion.driver && (
          <Button size="sm" variant="ghost" onClick={() => setDriver(suggestion.driver)}>
            {fill(t('cb.form.useSuggestion'), { name: suggestion.name ?? suggestion.driver ?? '' })}
          </Button>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cb.form.schedule')}>
            {(id) => (
              <Select id={id} value={schedule} onChange={(e) => setSchedule(e.target.value as 'daily' | 'off')}>
                <option value="daily">{t('cb.form.daily')}</option>
                <option value="off">{t('cb.form.off')}</option>
              </Select>
            )}
          </Field>
          {schedule === 'daily' && (
            <Field label={fill(t('cb.form.hour'), { tz: timezone })}>
              {(id) => (
                <Select id={id} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourText(h)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        <label className="inline-flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-3.5 accent-[var(--color-accent)]" checked={withCreds} onChange={(e) => setWithCreds(e.target.checked)} />
          {t('cb.form.withCreds')}
        </label>
        {withCreds && (
          <div className="space-y-3 rounded-[var(--radius-control)] border border-line p-3">
            <p className="text-xs text-muted">{t('cb.cred.hint')}</p>
            <CredentialFields value={creds} onChange={setCreds} errors={errors} />
            {!credBody && <p className="text-xs text-muted">{t('cb.cred.needSecret')}</p>}
            <label className="inline-flex items-center gap-2 text-[13px]">
              <input type="checkbox" className="size-3.5 accent-[var(--color-accent)]" checked={runNow} onChange={(e) => setRunNow(e.target.checked)} />
              {t('cb.form.runNow')}
            </label>
          </div>
        )}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!address.trim() || (withCreds && !credBody)}>
            {t('cb.form.add')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Administrator edit of name, port, vendor, on/off and schedule (PATCH, only the fields that changed). */
export function TargetSettingsCard({ target, drivers, onSaved }: { target: Target; drivers: Driver[]; onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(target.name);
  const [port, setPort] = useState(target.port);
  const [driver, setDriver] = useState<string | null>(target.driver);
  const [enabled, setEnabled] = useState(target.enabled);
  const [schedule, setSchedule] = useState(target.schedule);
  const [hour, setHour] = useState(target.schedule_hour);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const errors = fieldErrors(error);

  const patch: Record<string, unknown> = {};
  if (name.trim() !== target.name) patch.name = name.trim();
  if (port !== target.port) patch.port = port;
  if (driver !== target.driver) patch.driver = driver;
  if (enabled !== target.enabled) patch.enabled = enabled;
  if (schedule !== target.schedule) patch.schedule = schedule;
  if (hour !== target.schedule_hour) patch.schedule_hour = hour;
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/config-backup/targets/${target.id}`, { method: 'PATCH', body: patch });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('cb.form.settings')}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void save();
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="cb-enabled" className="text-[13px] font-medium">
            {t('cb.form.enabled')}
          </label>
          <Switch id="cb-enabled" checked={enabled} onChange={setEnabled} />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field label={t('common.name')} error={errors.name}>
            {(id) => <Input id={id} dir="auto" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label={t('cb.form.port')} error={errors.port}>
            {(id) => <Input id={id} type="number" dir="ltr" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />}
          </Field>
        </div>
        <Field label={t('cb.form.vendor')} hint={t('cb.form.vendorHint')} error={errors.driver}>
          {(id) => <DriverSelect id={id} value={driver} onChange={setDriver} drivers={drivers} />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cb.form.schedule')}>
            {(id) => (
              <Select id={id} value={schedule} onChange={(e) => setSchedule(e.target.value as 'daily' | 'off')}>
                <option value="daily">{t('cb.form.daily')}</option>
                <option value="off">{t('cb.form.off')}</option>
              </Select>
            )}
          </Field>
          {schedule === 'daily' && (
            <Field label={fill(t('cb.form.hour'), { tz: target.site_timezone })}>
              {(id) => (
                <Select id={id} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hourText(h)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        <ErrorNote error={error} />
        {saved && !dirty && <Notice>{t('common.saved')}</Notice>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" busy={busy} disabled={!dirty}>
            {t('cb.form.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
