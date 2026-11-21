'use client';

import { Field, Input, Select } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { Catalog, Severity, Trigger } from '../types';
import { CheckList, eventTypeLabel, usePbText } from './common';

const SEVERITIES: Severity[] = ['info', 'warning', 'critical'];
const SEV_LABEL = { en: { info: 'Info', warning: 'Warning', critical: 'Critical' }, ar: { info: 'معلومة', warning: 'تحذير', critical: 'حرج' } } as const;
const TRUSTS = ['unreviewed', 'known', 'unwanted'] as const;
const CHECK_ROLES = ['gateway', 'internet', 'dns', 'service'] as const;
const KIND_LABEL = {
  en: { network: 'Network', service: 'Service', collector: 'Collector', device: 'Device' },
  ar: { network: 'الشبكة', service: 'خدمة', collector: 'مجمِّع', device: 'جهاز' },
} as const;
const ROLE_LABEL = { en: { gateway: 'Gateway', internet: 'Internet', dns: 'DNS', service: 'Service' }, ar: { gateway: 'البوابة', internet: 'الإنترنت', dns: 'DNS', service: 'خدمة' } } as const;

/** A fresh trigger of a kind, with sensible defaults. */
export function defaultTrigger(kind: Trigger['kind']): Trigger {
  switch (kind) {
    case 'event':
      return { kind: 'event', event_types: ['device_offline'], filters: {} };
    case 'incident':
      return { kind: 'incident', on: 'opened' };
    case 'schedule':
      return { kind: 'schedule', daily_at: '02:00' };
    default:
      return { kind: 'manual' };
  }
}

export function TriggerEditor({ value, onChange, catalog, disabled }: { value: Trigger; onChange: (t: Trigger) => void; catalog: Catalog; disabled?: boolean }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const sev = SEV_LABEL[locale];
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <Field label={tx.trigger}>
        {(id) => (
          <Select id={id} value={value.kind} onChange={(e) => onChange(defaultTrigger(e.target.value as Trigger['kind']))}>
            {(['event', 'incident', 'schedule', 'manual'] as const).map((k) => (
              <option key={k} value={k}>
                {tx.triggerKind[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {value.kind === 'event' && (
        <>
          <CheckList
            label={tx.eventTypes}
            options={catalog.trigger_event_types.map((t) => ({ value: t, label: eventTypeLabel(t, locale) }))}
            value={value.event_types}
            onChange={(event_types) => onChange({ ...value, event_types })}
          />
          <div className="space-y-3 rounded-[var(--radius-control)] border border-line p-3">
            <p className="text-xs font-medium text-muted">{tx.filters}</p>
            <CheckList
              label={tx.severities}
              options={SEVERITIES.map((s) => ({ value: s, label: sev[s] }))}
              value={value.filters?.severities ?? []}
              onChange={(severities) => onChange({ ...value, filters: { ...value.filters, severities: severities.length ? severities : undefined } })}
            />
            <CheckList
              label={tx.deviceTrust}
              options={TRUSTS.map((t) => ({ value: t, label: tx.trustOpts[t] }))}
              value={(value.filters?.device_trust ?? []) as (typeof TRUSTS)[number][]}
              onChange={(device_trust) => onChange({ ...value, filters: { ...value.filters, device_trust: device_trust.length ? device_trust : undefined } })}
            />
            <CheckList
              label={tx.checkRoles}
              options={CHECK_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[locale][r] }))}
              value={(value.filters?.check_roles ?? []) as (typeof CHECK_ROLES)[number][]}
              onChange={(check_roles) => onChange({ ...value, filters: { ...value.filters, check_roles: check_roles.length ? check_roles : undefined } })}
            />
            <label className="inline-flex items-center gap-1.5 text-[13px] text-fg">
              <input
                type="checkbox"
                className="size-3.5 accent-[var(--color-accent)]"
                checked={Boolean(value.filters?.critical_only)}
                onChange={(e) => onChange({ ...value, filters: { ...value.filters, critical_only: e.target.checked || undefined } })}
              />
              {tx.criticalOnly}
            </label>
          </div>
        </>
      )}

      {value.kind === 'incident' && (
        <>
          <Field label={tx.incidentOn}>
            {(id) => (
              <Select id={id} value={value.on} onChange={(e) => onChange({ ...value, on: e.target.value as 'opened' | 'resolved' })}>
                <option value="opened">{tx.opened}</option>
                <option value="resolved">{tx.resolved}</option>
              </Select>
            )}
          </Field>
          <CheckList
            label={tx.incidentKinds}
            options={catalog.incident_kinds.map((k) => ({ value: k, label: KIND_LABEL[locale][k as keyof (typeof KIND_LABEL)['en']] ?? k }))}
            value={value.incident_kinds ?? []}
            onChange={(incident_kinds) => onChange({ ...value, incident_kinds: incident_kinds.length ? incident_kinds : undefined })}
          />
          <CheckList
            label={tx.severities}
            options={SEVERITIES.map((s) => ({ value: s, label: sev[s] }))}
            value={value.severities ?? []}
            onChange={(severities) => onChange({ ...value, severities: severities.length ? severities : undefined })}
          />
        </>
      )}

      {value.kind === 'schedule' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={tx.scheduleMode}>
            {(id) => (
              <Select
                id={id}
                value={value.every_minutes !== undefined ? 'every' : 'daily'}
                onChange={(e) => onChange(e.target.value === 'every' ? { kind: 'schedule', every_minutes: 60 } : { kind: 'schedule', daily_at: '02:00' })}
              >
                <option value="daily">{tx.dailyAt}</option>
                <option value="every">{tx.everyMinutes}</option>
              </Select>
            )}
          </Field>
          {value.every_minutes !== undefined ? (
            <Field label={tx.everyMinutes}>
              {(id) => <Input id={id} type="number" min={5} max={1440} value={value.every_minutes} onChange={(e) => onChange({ ...value, every_minutes: Number(e.target.value) })} />}
            </Field>
          ) : (
            <>
              <Field label={tx.dailyAt}>
                {(id) => <Input id={id} type="time" dir="ltr" value={value.daily_at ?? ''} onChange={(e) => onChange({ ...value, daily_at: e.target.value })} />}
              </Field>
              <Field label={tx.timezone}>
                {(id) => <Input id={id} dir="ltr" placeholder="Africa/Cairo" value={value.timezone ?? ''} onChange={(e) => onChange({ ...value, timezone: e.target.value || undefined })} />}
              </Field>
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}
