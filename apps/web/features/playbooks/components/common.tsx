'use client';

import { useState } from 'react';
import { Badge, Field, Input, Select, type Tone } from '@/components/ui';
import { ApiError, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { EVENT_TYPE_LABEL } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { playbooksText, runStatusLabel, stepStatusLabel } from '../text';
import type { RunStatus, StepStatus } from '../types';

export function usePbText() {
  const { locale } = useI18n();
  return playbooksText(locale);
}

export const RUN_TONE: Record<RunStatus, Tone> = {
  queued: 'info',
  running: 'info',
  waiting: 'info',
  awaiting_approval: 'warn',
  succeeded: 'ok',
  stopped: 'idle',
  failed: 'crit',
  rejected: 'crit',
  expired: 'warn',
  cancelled: 'idle',
  skipped: 'idle',
};

export const STEP_TONE: Record<StepStatus, Tone> = {
  pending: 'idle',
  awaiting_approval: 'warn',
  approved: 'info',
  running: 'info',
  succeeded: 'ok',
  failed: 'crit',
  skipped: 'idle',
  rejected: 'crit',
  expired: 'warn',
  previewed: 'info',
  cancelled: 'idle',
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const { locale } = useI18n();
  return <Badge tone={RUN_TONE[status]}>{runStatusLabel(status, locale)}</Badge>;
}

export function StepStatusBadge({ status }: { status: StepStatus }) {
  const { locale } = useI18n();
  return <Badge tone={STEP_TONE[status]}>{stepStatusLabel(status, locale)}</Badge>;
}

export function eventTypeLabel(type: string, locale: 'en' | 'ar'): string {
  return EVENT_TYPE_LABEL[type]?.[locale] ?? type.replace(/_/g, ' ');
}

/** Validation details from the API, shown as a list next to the form. */
export function ApiErrors({ error }: { error: unknown }) {
  const tx = usePbText();
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div role="alert" className="rounded-[var(--radius-control)] border border-crit/40 bg-crit/[0.06] px-3 py-2 text-[13px] text-fg">
      <p className="font-medium text-crit">{e instanceof ApiError && e.details?.length ? tx.fixErrors : e.message}</p>
      {e instanceof ApiError && e.details?.length ? (
        <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs">
          {e.details.map((d, i) => (
            <li key={i}>
              <span className="mono text-faint" dir="ltr">
                {d.path}
              </span>{' '}
              {d.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface DeviceOption {
  id: string;
  display_name: string | null;
  hostname: string | null;
  current_ip: string | null;
  primary_mac: string | null;
}

const deviceName = (d: DeviceOption) => d.display_name ?? d.hostname ?? d.current_ip ?? d.primary_mac ?? d.id;

/** Search-and-pick a device. `null` means "the trigger's device" when `allowTrigger` is set. */
export function DevicePicker({ value, onChange, label, hint, allowTrigger, siteId }: { value: string | null; onChange: (id: string | null) => void; label: string; hint?: string; allowTrigger?: boolean; siteId?: string | null }) {
  const tx = usePbText();
  const { siteId: globalSite } = useApp();
  const [q, setQ] = useState('');
  const list = useQuery<{ items: DeviceOption[] }>(`/devices${qs({ q: q || undefined, site_id: siteId ?? globalSite, page_size: 25 })}`, ['devices'], 0);
  const items = list.data?.items ?? [];
  const selectedMissing = value && !items.some((d) => d.id === value);
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr]">
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx.searchDevice} aria-label={tx.searchDevice} />
          <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
            {allowTrigger ? <option value="">{tx.triggerDevice}</option> : <option value="">—</option>}
            {selectedMissing && <option value={value}>{value}</option>}
            {items.map((d) => (
              <option key={d.id} value={d.id}>
                {deviceName(d)}
                {d.current_ip && deviceName(d) !== d.current_ip ? ` (${d.current_ip})` : ''}
              </option>
            ))}
          </Select>
        </div>
      )}
    </Field>
  );
}

/** A row of checkboxes for a multi-choice list. */
export function CheckList<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-xs font-medium text-fg/85">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((o) => (
          <label key={o.value} className="inline-flex items-center gap-1.5 text-[13px] text-fg">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--color-accent)]"
              checked={value.includes(o.value)}
              onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
