'use client';

import { useMemo, useState } from 'react';
import type { EndpointSummary, FleetGroup, FleetJob, FleetScript, FleetScriptParam } from '@nigafiy/shared-types';
import { Async, Button, Field, Input, Modal, Segmented, Select, Switch } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { codeMessage, policyText } from '../fleet-policy/policy-text';
import { type JobsText, jobsText } from './jobs-text';

type Value = string | number | boolean;

/** API refusals in the user's language (these codes first, then the access-policy ones). */
export function jobsError(tx: JobsText, err: ApiError | null, locale: string): string | null {
  if (!err) return null;
  const base = tx.codes[err.code] ?? codeMessage(policyText(locale), err) ?? err.message;
  const details = err.details?.map((d) => d.message).join(' ');
  return details && err.code === 'invalid_parameters' ? `${base} ${details}` : base;
}

/** Starting values from the script's declared defaults. */
function defaults(params: FleetScriptParam[]): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const p of params) {
    if (p.default !== null && p.default !== undefined) out[p.name] = p.default;
    else if (p.type === 'bool') out[p.name] = false;
  }
  return out;
}

/** The value inputs of a script's typed parameters. */
export function ParamInputs({ params, values, onChange }: { params: FleetScriptParam[]; values: Record<string, Value>; onChange: (v: Record<string, Value>) => void }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  if (params.length === 0) return null;
  const set = (name: string, v: Value | undefined) => {
    const next = { ...values };
    if (v === undefined || v === '') delete next[name];
    else next[name] = v;
    onChange(next);
  };
  return (
    <fieldset className="space-y-3 rounded-md border border-line p-3">
      <legend className="px-1 text-xs font-medium text-muted">{tx.parameters}</legend>
      {params.map((p) => {
        const label = `${p.label || p.name}${p.required ? ' *' : ''}`;
        const v = values[p.name];
        return (
          <Field key={p.name} label={label} hint={`${ltr(p.name)} · ${tx.paramTypes[p.type]}${p.min !== null || p.max !== null ? ` · ${ltr(`${p.min ?? '…'}–${p.max ?? '…'}`)}` : ''}`}>
            {(id) =>
              p.type === 'bool' ? (
                <Switch id={id} checked={v === true} onChange={(c) => set(p.name, c)} label={label} />
              ) : p.type === 'choice' ? (
                <Select id={id} value={typeof v === 'string' ? v : ''} onChange={(e) => set(p.name, e.target.value || undefined)}>
                  <option value="">—</option>
                  {(p.choices ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              ) : p.type === 'int' ? (
                <Input id={id} type="number" step={1} min={p.min ?? undefined} max={p.max ?? undefined} value={v === undefined ? '' : String(v)} onChange={(e) => set(p.name, e.target.value === '' ? undefined : Number(e.target.value))} dir="ltr" />
              ) : (
                <Input id={id} value={typeof v === 'string' ? v : ''} maxLength={p.max_length ?? 4000} onChange={(e) => set(p.name, e.target.value === '' ? undefined : e.target.value)} dir="auto" />
              )
            }
          </Field>
        );
      })}
    </fieldset>
  );
}

const zones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
};

/**
 * New job: a script and its typed parameters (checked again on the server), the computers (the
 * address book's selection, chosen computers, or a group), and when: now, once later, or on a
 * schedule in a time zone, optionally only inside maintenance windows, with an expiry for
 * computers that are offline.
 */
export function JobDialog({ endpointIds, onClose, onCreated, scriptId }: { endpointIds?: string[]; scriptId?: string; onClose: () => void; onCreated: (job: FleetJob) => void }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const scriptsQ = useQuery<{ scripts: FleetScript[] }>('/fleet/scripts', ['devices'], 60_000);
  const groupsQ = useQuery<{ groups: FleetGroup[] }>('/fleet/groups', ['devices'], 60_000);
  const fixed = endpointIds && endpointIds.length > 0;
  const endpointsQ = useQuery<{ items: EndpointSummary[] }>(fixed ? null : '/endpoints', ['devices'], 60_000);
  const [script, setScript] = useState(scriptId ?? '');
  const [values, setValues] = useState<Record<string, Value>>({});
  const [name, setName] = useState('');
  const [targetKind, setTargetKind] = useState<'endpoints' | 'group'>('endpoints');
  const [picked, setPicked] = useState<string[]>([]);
  const [groupId, setGroupId] = useState('');
  const [kind, setKind] = useState<'now' | 'once' | 'recurring'>('now');
  const [runAt, setRunAt] = useState('');
  const [every, setEvery] = useState<'hourly' | 'daily' | 'weekly' | 'monthly'>('daily');
  const [time, setTime] = useState('03:00');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [monthday, setMonthday] = useState(1);
  const [timezone, setTimezone] = useState('');
  const [maintenance, setMaintenance] = useState(false);
  const [expiry, setExpiry] = useState(1440);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const tzList = useMemo(zones, []);

  const chosen = scriptsQ.data?.scripts.find((s) => s.id === script) ?? null;
  const targets = fixed ? endpointIds! : picked;
  const ready =
    Boolean(chosen) &&
    (targetKind === 'group' && !fixed ? Boolean(groupId) : targets.length > 0) &&
    (kind !== 'once' || Boolean(runAt)) &&
    (kind !== 'recurring' || /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) &&
    (chosen?.current.parameters ?? []).every((p) => !p.required || values[p.name] !== undefined);

  async function submit() {
    if (!chosen || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const schedule =
        kind === 'now'
          ? { kind }
          : kind === 'once'
            ? { kind, run_at: new Date(runAt).toISOString() }
            : { kind, every, time, ...(every === 'weekly' ? { weekdays } : {}), ...(every === 'monthly' ? { monthday } : {}) };
      const job = await api<FleetJob>('/fleet/jobs', {
        method: 'POST',
        body: {
          ...(name.trim() ? { name: name.trim() } : {}),
          script_id: chosen.id,
          parameters: values,
          target: targetKind === 'group' && !fixed ? { kind: 'group', fleet_group_id: groupId } : { kind: 'endpoints', endpoint_ids: targets },
          schedule,
          ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
          maintenance_only: maintenance,
          expiry_minutes: expiry,
        },
      });
      onCreated(job);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={tx.newJob} onClose={onClose} wide>
      <Async query={scriptsQ}>
        {({ scripts }) => (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field label={tx.script}>
              {(id) => (
                <Select
                  id={id}
                  value={script}
                  onChange={(e) => {
                    setScript(e.target.value);
                    setValues(defaults(scripts.find((s) => s.id === e.target.value)?.current.parameters ?? []));
                  }}
                  autoFocus
                >
                  <option value="" disabled>
                    {tx.pickScript}
                  </option>
                  {scripts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {tx.osName[s.os]} · {tx.version(s.current_version)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {chosen && <ParamInputs params={chosen.current.parameters} values={values} onChange={setValues} />}

            <Field label={tx.jobName}>{(id) => <Input id={id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} dir="auto" />}</Field>

            <div className="space-y-2">
              <p className="text-sm font-medium">{tx.target}</p>
              {fixed ? (
                <p className="text-sm text-muted">{tx.targetSelected(endpointIds!.length)}</p>
              ) : (
                <>
                  <Segmented
                    label={tx.target}
                    value={targetKind}
                    onChange={setTargetKind}
                    options={[
                      { value: 'endpoints', label: tx.targetComputers },
                      { value: 'group', label: tx.targetGroup },
                    ]}
                  />
                  {targetKind === 'group' ? (
                    <Select value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-label={tx.group}>
                      <option value="" disabled>
                        {tx.group}
                      </option>
                      {(groupsQ.data?.groups ?? []).map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <div role="group" aria-label={tx.pickComputers} className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-line p-2 text-sm">
                      {(endpointsQ.data?.items ?? [])
                        .filter((e) => !chosen || (chosen.os === 'windows' ? e.platform === 'windows' : e.platform !== 'windows'))
                        .map((e) => (
                          <label key={e.id} className="flex items-center gap-2">
                            <input type="checkbox" checked={picked.includes(e.id)} onChange={(ev) => setPicked(ev.target.checked ? [...picked, e.id] : picked.filter((x) => x !== e.id))} />
                            <span dir="auto">{e.name}</span>
                            <span className="text-xs text-faint">{e.site_name}</span>
                          </label>
                        ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="space-y-3">
              <Segmented
                label={tx.when}
                value={kind}
                onChange={setKind}
                options={(['now', 'once', 'recurring'] as const).map((k) => ({ value: k, label: tx.scheduleKind[k]! }))}
              />
              {kind === 'once' && <Field label={tx.runAt}>{(id) => <Input id={id} type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} dir="ltr" />}</Field>}
              {kind === 'recurring' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={tx.every}>
                    {(id) => (
                      <Select id={id} value={every} onChange={(e) => setEvery(e.target.value as typeof every)}>
                        {(['hourly', 'daily', 'weekly', 'monthly'] as const).map((x) => (
                          <option key={x} value={x}>
                            {tx.everyName[x]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={every === 'hourly' ? tx.atMinute : tx.at}>{(id) => <Input id={id} value={time} onChange={(e) => setTime(e.target.value)} placeholder="03:00" dir="ltr" />}</Field>
                  {every === 'weekly' && (
                    <div role="group" aria-label={tx.weekdays} className="flex flex-wrap gap-2 text-sm sm:col-span-2">
                      {tx.weekdayNames.map((d, i) => (
                        <label key={d} className="flex items-center gap-1">
                          <input type="checkbox" checked={weekdays.includes(i)} onChange={(e) => setWeekdays(e.target.checked ? [...weekdays, i] : weekdays.filter((x) => x !== i))} />
                          {d}
                        </label>
                      ))}
                    </div>
                  )}
                  {every === 'monthly' && (
                    <Field label={tx.monthday}>{(id) => <Input id={id} type="number" min={1} max={28} value={monthday} onChange={(e) => setMonthday(Number(e.target.value))} dir="ltr" />}</Field>
                  )}
                </div>
              )}
              {kind !== 'now' && (
                <Field label={tx.timezone} hint={tx.timezoneHint}>
                  {(id) => (
                    <>
                      <Input id={id} value={timezone} list="nigafiy-tz" onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Riyadh" dir="ltr" />
                      <datalist id="nigafiy-tz">
                        {tzList.map((z) => (
                          <option key={z} value={z} />
                        ))}
                      </datalist>
                    </>
                  )}
                </Field>
              )}
              <div className="flex items-start gap-2">
                <Switch checked={maintenance} onChange={setMaintenance} label={tx.maintenanceOnly} />
                <div className="text-sm">
                  <p>{tx.maintenanceOnly}</p>
                  <p className="text-xs text-muted">{tx.maintenanceHint}</p>
                </div>
              </div>
              <Field label={tx.expiry} hint={tx.expiryHint}>
                {(id) => <Input id={id} type="number" min={5} max={43200} value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} dir="ltr" />}
              </Field>
            </div>

            {error && (
              <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
                {jobsError(tx, error, locale)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={onClose}>
                {tx.cancel}
              </Button>
              <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
                {tx.create}
              </Button>
            </div>
          </form>
        )}
      </Async>
    </Modal>
  );
}
