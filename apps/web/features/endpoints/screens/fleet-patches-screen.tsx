'use client';

import { PackageCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FleetGroup, FleetPatchCatalogItem, FleetPatchClassification, FleetPatchInstall, FleetPatchPolicy } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, DataTable, Field, Input, Modal, PageHeader, Select, Switch, Tabs } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { PatchInstallsTable } from '../components/fleet-patches/installs-table';
import { type PatchesText, formatBytes, patchesText } from '../components/fleet-patches/patches-text';

const CLASSES: FleetPatchClassification[] = ['critical', 'security', 'definition', 'update_rollup', 'service_pack', 'feature_pack', 'update', 'driver', 'tool', 'upgrade', 'other'];

type View = 'catalog' | 'policies' | 'installs';

/** Nigafiy Fleet → Patches: missing updates across the fleet, decisions, policies and installs. */
export function FleetPatchesScreen() {
  const { locale } = useI18n();
  const t = patchesText(locale);
  const { can } = useApp();
  const [view, setView] = useState<View>('catalog');
  return (
    <div className="space-y-5">
      <PageHeader title={t.title} description={t.subtitle} icon={<PackageCheck className="size-5" aria-hidden />} />
      <Tabs
        value={view}
        label={t.title}
        onChange={(v) => setView(v)}
        options={[
          { value: 'catalog', label: t.catalog },
          { value: 'policies', label: t.policies },
          { value: 'installs', label: t.installs },
        ]}
      />
      {view === 'catalog' && <Catalog t={t} canAdmin={can('admin')} />}
      {view === 'policies' && <Policies t={t} canAdmin={can('admin')} />}
      {view === 'installs' && <Installs canAdmin={can('admin')} />}
    </div>
  );
}

function Installs({ canAdmin }: { canAdmin: boolean }) {
  const q = useQuery<{ installs: FleetPatchInstall[] }>('/fleet/patches/installs?limit=200', ['devices'], 20_000);
  return (
    <Card padded={false}>
      <Async query={q}>{({ installs }) => <PatchInstallsTable installs={installs} showComputer canAdmin={canAdmin} onChanged={() => void q.reload()} />}</Async>
    </Card>
  );
}

function Catalog({ t, canAdmin }: { t: PatchesText; canAdmin: boolean }) {
  const q = useQuery<{ updates: FleetPatchCatalogItem[] }>('/fleet/patches/catalog', ['devices'], 60_000);
  const groupsQ = useQuery<{ groups: FleetGroup[] }>(canAdmin ? '/fleet/groups' : null, ['devices'], 60_000);
  const [scope, setScope] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
    void q.reload();
  }

  return (
    <div className="space-y-3">
      {canAdmin && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="patch-scope">{t.scope}</label>
          <Select id="patch-scope" value={scope} onChange={(e) => setScope(e.target.value)} className="w-auto max-w-full">
            <option value="">{t.allGroups}</option>
            {(groupsQ.data?.groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {t.forGroup(g.name)}
              </option>
            ))}
          </Select>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
          {error}
        </p>
      )}
      <Card padded={false}>
        <Async query={q}>
          {({ updates }) =>
            updates.length === 0 ? (
              <p className="p-5 text-sm text-muted">{t.noUpdates}</p>
            ) : (
              <DataTable minWidth={820}>
                <thead>
                  <tr>
                    <th>{t.update}</th>
                    <th>{t.classification}</th>
                    <th>{t.size}</th>
                    <th>{t.missingOn}</th>
                    <th>{t.decision}</th>
                    {canAdmin && <th />}
                  </tr>
                </thead>
                <tbody>
                  {updates.map((u) => {
                    const mine = u.approvals.find((a) => (a.fleet_group_id ?? '') === scope);
                    return (
                      <tr key={u.update_id}>
                        <td className="text-sm">
                          <span dir="auto">{u.title}</span>
                          {u.kb && <span className="mono ms-2 text-xs text-muted">{ltr(u.kb)}</span>}
                          <div className="text-xs text-faint">{t.source[u.source]}</div>
                        </td>
                        <td className="text-xs">
                          {t.classes[u.classification]}
                          {u.severity && <div className="text-faint">{ltr(u.severity)}</div>}
                        </td>
                        <td className="text-xs">{formatBytes(u.size_bytes) ? ltr(formatBytes(u.size_bytes)!) : t.notMeasured}</td>
                        <td className="text-sm">{u.missing_on}</td>
                        <td className="space-y-1 text-xs">
                          {u.approvals.length === 0 && <Badge tone="idle">{t.approval.not_approved}</Badge>}
                          {u.approvals.map((a) => (
                            <div key={a.id}>
                              <Badge tone={a.decision === 'approved' ? 'ok' : 'crit'}>{t.approval[a.decision]}</Badge>{' '}
                              <span className="text-faint" dir="auto">
                                {a.fleet_group_name ? t.forGroup(a.fleet_group_name) : t.allGroups} · {a.decided_by_email}
                              </span>
                            </div>
                          ))}
                        </td>
                        {canAdmin && (
                          <td className="whitespace-nowrap">
                            <Button size="sm" disabled={mine?.decision === 'approved'} onClick={() => void run(() => api('/fleet/patches/approvals', { method: 'POST', body: { update_id: u.update_id, fleet_group_id: scope || null, decision: 'approved' } }))}>
                              {t.approve}
                            </Button>{' '}
                            <Button size="sm" disabled={mine?.decision === 'declined'} onClick={() => void run(() => api('/fleet/patches/approvals', { method: 'POST', body: { update_id: u.update_id, fleet_group_id: scope || null, decision: 'declined' } }))}>
                              {t.decline}
                            </Button>{' '}
                            {mine && (
                              <Button size="sm" aria-label={t.clear} onClick={() => void run(() => api(`/fleet/patches/approvals/${mine.id}`, { method: 'DELETE' }))}>
                                <Trash2 className="size-3.5" aria-hidden />
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            )
          }
        </Async>
      </Card>
    </div>
  );
}

function policySummary(p: FleetPatchPolicy, t: PatchesText): string {
  if (!p.enabled) return t.disabled;
  const win = p.window_kind === 'maintenance' ? t.windowMaintenance : `${(p.window_weekdays ?? []).map((d) => t.days[d]).join(', ')} ${p.window_start} · ${p.window_minutes} min · ${p.window_timezone}`;
  const auto = p.auto_approve.length ? `${t.autoApprove}: ${p.auto_approve.map((c) => t.classes[c]).join(', ')}` : '';
  return [win, t.rebootPolicies[p.reboot_policy], auto].filter(Boolean).join(' — ');
}

function Policies({ t, canAdmin }: { t: PatchesText; canAdmin: boolean }) {
  const q = useQuery<{ policies: FleetPatchPolicy[]; default: FleetPatchPolicy }>('/fleet/patches/policies', ['devices'], 60_000);
  const groupsQ = useQuery<{ groups: FleetGroup[] }>(canAdmin ? '/fleet/groups' : null, ['devices'], 60_000);
  const [editing, setEditing] = useState<{ policy: FleetPatchPolicy; groupId: string | null; groupName: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(groupId: string) {
    setError(null);
    try {
      await api(`/fleet/patches/policies/group/${groupId}`, { method: 'DELETE' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
    void q.reload();
  }

  return (
    <Async query={q}>
      {({ policies, default: def }) => {
        const groups = groupsQ.data?.groups ?? [];
        return (
          <div className="space-y-3">
            {error && (
              <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
                {error}
              </p>
            )}
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{t.orgDefault}</p>
                  <p className="text-xs text-muted">{policySummary(def, t)}</p>
                </div>
                {canAdmin && (
                  <Button size="sm" onClick={() => setEditing({ policy: def, groupId: null, groupName: null })}>
                    {t.edit}
                  </Button>
                )}
              </div>
            </Card>
            {policies
              .filter((p) => p.fleet_group_id)
              .map((p) => (
                <Card key={p.id}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium" dir="auto">
                        {t.groupPolicy}: {p.fleet_group_name}
                      </p>
                      <p className="text-xs text-muted">{policySummary(p, t)}</p>
                    </div>
                    {canAdmin && (
                      <div className="flex gap-1.5">
                        <Button size="sm" onClick={() => setEditing({ policy: p, groupId: p.fleet_group_id, groupName: p.fleet_group_name })}>
                          {t.edit}
                        </Button>
                        <Button size="sm" onClick={() => void remove(p.fleet_group_id!)}>
                          {t.removeGroupPolicy}
                        </Button>
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            {canAdmin && groups.some((g) => !policies.some((p) => p.fleet_group_id === g.id)) && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t.addGroupPolicy}</span>
                <Select
                  aria-label={t.addGroupPolicy}
                  value=""
                  className="w-auto max-w-full"
                  onChange={(e) => {
                    const g = groups.find((x) => x.id === e.target.value);
                    if (g) setEditing({ policy: { ...def, id: null }, groupId: g.id, groupName: g.name });
                  }}
                >
                  <option value="">—</option>
                  {groups
                    .filter((g) => !policies.some((p) => p.fleet_group_id === g.id))
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                </Select>
              </div>
            )}
            {editing && (
              <PolicyEditor
                t={t}
                policy={editing.policy}
                groupId={editing.groupId}
                title={editing.groupName ? `${t.groupPolicy}: ${editing.groupName}` : t.orgDefault}
                onClose={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  void q.reload();
                }}
              />
            )}
          </div>
        );
      }}
    </Async>
  );
}

function PolicyEditor({ t, policy, groupId, title, onClose, onSaved }: { t: PatchesText; policy: FleetPatchPolicy; groupId: string | null; title: string; onClose: () => void; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [auto, setAuto] = useState<FleetPatchClassification[]>(policy.auto_approve);
  const [kind, setKind] = useState(policy.window_kind);
  const [days, setDays] = useState<number[]>(policy.window_weekdays ?? [6]);
  const [start, setStart] = useState(policy.window_start ?? '02:00');
  const [minutes, setMinutes] = useState(String(policy.window_minutes ?? 120));
  const [tz, setTz] = useState(policy.window_timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [reboot, setReboot] = useState(policy.reboot_policy);
  const [maxPost, setMaxPost] = useState(String(policy.max_postponements));
  const [postMin, setPostMin] = useState(String(policy.postpone_minutes));
  const [deadline, setDeadline] = useState(String(policy.reboot_deadline_hours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/fleet/patches/policies', {
        method: 'PUT',
        body: {
          fleet_group_id: groupId,
          enabled,
          auto_approve: auto,
          window_kind: kind,
          ...(kind === 'group' ? { window_weekdays: days, window_start: start, window_minutes: Number(minutes), window_timezone: tz } : {}),
          reboot_policy: reboot,
          max_postponements: Number(maxPost),
          postpone_minutes: Number(postMin),
          reboot_deadline_hours: Number(deadline),
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? [err.message, ...(err.details ?? []).map((d) => `${d.path}: ${d.message}`)].join(' ') : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center gap-2 text-sm">
          <Switch checked={enabled} onChange={setEnabled} label={t.enabled} />
          <span>{enabled ? t.enabled : t.disabled}</span>
        </div>
        <fieldset className="space-y-2 rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-medium text-muted">{t.autoApprove}</legend>
          <p className="text-xs text-muted">{t.autoApproveHint}</p>
          <div className="flex flex-wrap gap-3">
            {CLASSES.map((c) => (
              <label key={c} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={auto.includes(c)} onChange={() => setAuto(toggle(auto, c))} />
                {t.classes[c]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-2 rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-medium text-muted">{t.window}</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" name="patch-window" checked={kind === 'maintenance'} onChange={() => setKind('maintenance')} />
              {t.windowMaintenance}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="patch-window" checked={kind === 'group'} onChange={() => setKind('group')} />
              {t.windowGroup}
            </label>
          </div>
          {kind === 'group' && (
            <div className="space-y-3">
              <fieldset className="flex flex-wrap gap-3">
                <legend className="sr-only">{t.weekdays}</legend>
                {t.days.map((d, i) => (
                  <label key={d} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={days.includes(i)} onChange={() => setDays(toggle(days, i))} />
                    {d}
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t.start}>{(id) => <Input id={id} value={start} onChange={(e) => setStart(e.target.value)} dir="ltr" pattern="[0-2][0-9]:[0-5][0-9]" required />}</Field>
                <Field label={t.minutes}>{(id) => <Input id={id} type="number" min={30} max={720} value={minutes} onChange={(e) => setMinutes(e.target.value)} dir="ltr" required />}</Field>
                <Field label={t.timezone}>{(id) => <Input id={id} value={tz} onChange={(e) => setTz(e.target.value)} dir="ltr" required />}</Field>
              </div>
            </div>
          )}
        </fieldset>
        <Field label={t.rebootPolicy}>
          {(id) => (
            <Select id={id} value={reboot} onChange={(e) => setReboot(e.target.value as FleetPatchPolicy['reboot_policy'])}>
              {(['never', 'ask', 'force'] as const).map((r) => (
                <option key={r} value={r}>
                  {t.rebootPolicies[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {reboot === 'ask' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t.maxPostponements}>{(id) => <Input id={id} type="number" min={0} max={10} value={maxPost} onChange={(e) => setMaxPost(e.target.value)} dir="ltr" />}</Field>
            <Field label={t.postponeMinutes}>{(id) => <Input id={id} type="number" min={15} max={1440} value={postMin} onChange={(e) => setPostMin(e.target.value)} dir="ltr" />}</Field>
            <Field label={t.deadlineHours}>{(id) => <Input id={id} type="number" min={1} max={168} value={deadline} onChange={(e) => setDeadline(e.target.value)} dir="ltr" />}</Field>
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {t.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
