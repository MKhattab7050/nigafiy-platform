'use client';

import clsx from 'clsx';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FleetAccessPolicy, FleetBannerMode, FleetGroup, FleetHoursWindow, FleetOperatorRole, FleetPermissionProfile, FleetRecordingMode } from '@nigafiy/shared-types';
import { Button, Field, Input, Modal, Segmented, SectionLabel, Select, Switch, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { toolsText } from '../remote-desktop/tools-text';
import { jobsText } from '../fleet-jobs/jobs-text';
import { codeMessage, policyText, profileLabel } from './policy-text';

const ROLES: FleetOperatorRole[] = ['owner', 'admin', 'technician'];

/**
 * A fleet group and its access policy (admins): how sessions start, the rules (MFA, second admin,
 * hours, roles, operator addresses) and the default and maximum permission profiles.
 */
export function GroupEditor({
  group,
  profiles,
  onClose,
  onSaved,
}: {
  group: FleetGroup | null;
  profiles: FleetPermissionProfile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { locale } = useI18n();
  const tx = policyText(locale);
  const support = profiles.find((p) => p.builtin_key === 'support');
  const full = profiles.find((p) => p.builtin_key === 'full_admin');
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [color, setColor] = useState(group?.color ?? '#6B3FC7');
  const [policy, setPolicy] = useState<FleetAccessPolicy>(() => ({
    // New groups are silent by default (migration 052): unattended, banner off.
    access_mode: group?.access_mode ?? 'unattended',
    consent_timeout_s: group?.consent_timeout_s ?? 60,
    refuse_window_s: group?.refuse_window_s ?? 0,
    allowed_hours: group?.allowed_hours ?? [],
    allowed_roles: group?.allowed_roles ?? [...ROLES],
    default_profile_id: group?.default_profile_id ?? support?.id ?? profiles[0]?.id ?? '',
    max_profile_id: group?.max_profile_id ?? full?.id ?? profiles[0]?.id ?? '',
    mfa_required: group?.mfa_required ?? false,
    approval_required: group?.approval_required ?? false,
    approval_ttl_minutes: group?.approval_ttl_minutes ?? 15,
    ip_allowlist: group?.ip_allowlist ?? [],
    banner_mode: group?.banner_mode ?? 'off',
  }));
  const tt = toolsText(locale).groupRecording;
  const [recMode, setRecMode] = useState<FleetRecordingMode>(group?.recording_mode ?? 'optional');
  const [recDays, setRecDays] = useState(group?.recording_retention_days ?? 30);
  const [userMayView, setUserMayView] = useState(group?.user_may_view_recordings ?? false);
  const jx = jobsText(locale);
  const [shellOn, setShellOn] = useState(group?.shell_enabled ?? false);
  const [shellIdle, setShellIdle] = useState(group?.shell_idle_timeout_minutes ?? 15);
  const [ipText, setIpText] = useState((group?.ip_allowlist ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = <K extends keyof FleetAccessPolicy>(k: K, v: FleetAccessPolicy[K]) => setPolicy((p) => ({ ...p, [k]: v }));
  const setWindow = (i: number, w: Partial<FleetHoursWindow>) =>
    set(
      'allowed_hours',
      policy.allowed_hours.map((x, j) => (j === i ? { ...x, ...w } : x)),
    );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        color,
        ...policy,
        recording_mode: recMode,
        recording_retention_days: recDays,
        user_may_view_recordings: userMayView,
        shell_enabled: shellOn,
        shell_idle_timeout_minutes: shellIdle,
        ip_allowlist: ipText
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
      await api(group ? `/fleet/groups/${group.id}` : '/fleet/groups', { method: group ? 'PATCH' : 'POST', body });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy(false);
    }
  }

  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));

  return (
    <Modal title={group ? tx.policyOf(group.name) : tx.newGroupTitle} onClose={onClose} wide>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label={tx.name}>{(id) => <Input id={id} value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} dir="auto" />}</Field>
          <Field label={tx.colour}>{(id) => <Input id={id} type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-16 p-1" />}</Field>
        </div>
        <Field label={tx.description}>{(id) => <Textarea id={id} value={description} maxLength={300} rows={2} onChange={(e) => setDescription(e.target.value)} dir="auto" />}</Field>

        <section>
          <SectionLabel>{tx.access}</SectionLabel>
          <Segmented
            label={tx.access}
            value={policy.access_mode}
            options={[
              { value: 'attended', label: tx.attended },
              { value: 'unattended', label: tx.unattended },
            ]}
            onChange={(v) => setPolicy((p) => ({ ...p, access_mode: v, banner_mode: v === 'attended' ? 'shown' : p.access_mode === 'attended' ? 'off' : p.banner_mode }))}
          />
          <p className="mt-2 text-xs text-muted">{policy.access_mode === 'attended' ? tx.attendedHint(policy.consent_timeout_s) : tx.unattendedHint(policy.refuse_window_s)}</p>
          <div className="mt-2 max-w-60">
            {policy.access_mode === 'attended' ? (
              <Field label={tx.consentTimeout}>
                {(id) => <Input id={id} type="number" min={10} max={300} value={policy.consent_timeout_s} onChange={(e) => set('consent_timeout_s', num(e.target.value, 10, 300))} dir="ltr" />}
              </Field>
            ) : (
              <Field label={tx.refuseWindow} hint={tx.refuseWindowHint}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={300}
                    value={policy.refuse_window_s}
                    onChange={(e) => {
                      const n = num(e.target.value, 0, 300);
                      set('refuse_window_s', n > 0 && n < 10 ? 10 : n);
                    }}
                    dir="ltr"
                  />
                )}
              </Field>
            )}
          </div>
        </section>

        {/* The session banner (migration 051): minimized or off only for unattended groups. */}
        <section>
          <SectionLabel>{tx.banner}</SectionLabel>
          {policy.access_mode === 'unattended' ? (
            <>
              <Segmented<FleetBannerMode>
                label={tx.banner}
                value={policy.banner_mode}
                options={(['shown', 'minimized', 'off'] as const).map((m) => ({ value: m, label: tx.bannerModes[m] }))}
                onChange={(v) => set('banner_mode', v)}
              />
              <p className={clsx('mt-2 text-xs', policy.banner_mode === 'off' ? 'text-warn' : 'text-muted')}>{tx.bannerHints[policy.banner_mode]}</p>
              {policy.banner_mode !== 'shown' && policy.refuse_window_s > 0 && <p className="mt-1 text-xs text-warn">{tx.bannerRefuseNote}</p>}
              <p className="mt-1 text-xs text-muted">{tx.bannerAlwaysNote}</p>
            </>
          ) : (
            <p className="text-xs text-muted">{tx.bannerAttendedOnly}</p>
          )}
        </section>

        <section className="space-y-3">
          <SectionLabel>{tx.rules}</SectionLabel>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{tx.mfa}</span>
            <Switch checked={policy.mfa_required} label={tx.mfa} onChange={(v) => set('mfa_required', v)} />
          </div>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{tx.approval}</span>
            <Switch checked={policy.approval_required} label={tx.approval} onChange={(v) => set('approval_required', v)} />
          </div>
          {policy.approval_required && (
            <div className="max-w-60">
              <Field label={tx.approvalTtl}>
                {(id) => <Input id={id} type="number" min={1} max={240} value={policy.approval_ttl_minutes} onChange={(e) => set('approval_ttl_minutes', num(e.target.value, 1, 240))} dir="ltr" />}
              </Field>
            </div>
          )}

          {/* Session recording rule: the person always sees the recording mark while it runs. */}
          <div className="space-y-2 rounded-md border border-line p-3">
            <p className="text-xs font-medium text-fg/85">{tt.title}</p>
            <Segmented<FleetRecordingMode>
              value={recMode}
              onChange={setRecMode}
              label={tt.title}
              options={(['off', 'optional', 'required'] as const).map((m) => ({ value: m, label: tt.modes[m] }))}
            />
            <p className="text-xs text-muted">{tt.hints[recMode]}</p>
            {recMode !== 'off' && (
              <>
                <div className="max-w-60">
                  <Field label={tt.retention}>
                    {(id) => <Input id={id} type="number" min={1} max={3650} value={recDays} onChange={(e) => setRecDays(num(e.target.value, 1, 3650))} dir="ltr" />}
                  </Field>
                </div>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span>{tt.userMayView}</span>
                  <Switch checked={userMayView} label={tt.userMayView} onChange={setUserMayView} />
                </div>
              </>
            )}
          </div>

          {/* Remote shell (Fleet Pro): off unless switched on here; admins only, transcript kept. */}
          <div className="space-y-2 rounded-md border border-line p-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>{jx.policyShell}</span>
              <Switch checked={shellOn} label={jx.policyShell} onChange={setShellOn} />
            </div>
            <p className="text-xs text-muted">{jx.policyShellHint}</p>
            {shellOn && (
              <div className="max-w-60">
                <Field label={jx.policyShellIdle}>
                  {(id) => <Input id={id} type="number" min={1} max={240} value={shellIdle} onChange={(e) => setShellIdle(num(e.target.value, 1, 240))} dir="ltr" />}
                </Field>
              </div>
            )}
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-fg/85">{tx.roles}</p>
            <div className="flex flex-wrap gap-3 text-sm">
              {ROLES.map((r) => (
                <label key={r} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={policy.allowed_roles.includes(r)}
                    onChange={(e) => set('allowed_roles', e.target.checked ? [...policy.allowed_roles, r] : policy.allowed_roles.filter((x) => x !== r))}
                  />
                  {tx.role[r]}
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tx.defaultProfile}>
              {(id) => (
                <Select id={id} value={policy.default_profile_id} onChange={(e) => set('default_profile_id', e.target.value)}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {profileLabel(tx, p)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={tx.maxProfile}>
              {(id) => (
                <Select id={id} value={policy.max_profile_id} onChange={(e) => set('max_profile_id', e.target.value)}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {profileLabel(tx, p)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-fg/85">{tx.hours}</p>
            <p className="mb-2 text-xs text-muted">{tx.hoursHint(locale === 'ar' ? 'المنطقة الزمنية للموقع' : 'site time zone')}</p>
            {policy.allowed_hours.length === 0 && <p className="mb-2 text-sm text-muted">{tx.hoursAny}</p>}
            <ul className="space-y-2">
              {policy.allowed_hours.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: windows have no identity besides their position.
                <li key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
                  <div className="flex flex-wrap gap-1">
                    {tx.days.map((d, day) => (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={w.days.includes(day)}
                        onClick={() => setWindow(i, { days: w.days.includes(day) ? w.days.filter((x) => x !== day) : [...w.days, day].sort() })}
                        className={clsx('h-7 rounded-[5px] border px-2 text-xs', w.days.includes(day) ? 'border-accent bg-accent/10 text-fg' : 'border-line text-muted')}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  <Input type="time" value={w.start} onChange={(e) => setWindow(i, { start: e.target.value })} aria-label={tx.from} dir="ltr" className="w-28" />
                  <span aria-hidden>–</span>
                  <Input type="time" value={w.end} onChange={(e) => setWindow(i, { end: e.target.value })} aria-label={tx.to} dir="ltr" className="w-28" />
                  <Button type="button" size="sm" onClick={() => set('allowed_hours', policy.allowed_hours.filter((_, j) => j !== i))} aria-label={tx.remove} title={tx.remove}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
            {policy.allowed_hours.length < 14 && (
              <Button type="button" size="sm" className="mt-2" onClick={() => set('allowed_hours', [...policy.allowed_hours, { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }])}>
                <Plus className="size-3.5" aria-hidden />
                {tx.addWindow}
              </Button>
            )}
          </div>

          <Field label={tx.ipList} hint={tx.ipHint}>
            {(id) => <Textarea id={id} value={ipText} rows={3} onChange={(e) => setIpText(e.target.value)} dir="ltr" className="mono" placeholder="10.0.0.0/24" />}
          </Field>
        </section>

        {error && (
          <div role="alert" className="text-sm text-crit">
            <p>{codeMessage(tx, error)}</p>
            {error.details?.length ? (
              <ul className="mt-1 list-inside list-disc text-xs">
                {error.details.map((d, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: validation messages have no identity.
                  <li key={i}>{`${d.path ? `${d.path}: ` : ''}${d.message}`}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {tx.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || policy.allowed_roles.length === 0}>
            {tx.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
