'use client';

import { useState } from 'react';
import type { FleetGroup } from '@nigafiy/shared-types';
import { Button, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { codeMessage, policyText } from './policy-text';

/** The organization's fleet groups (technicians and above; viewers get none). */
export function useFleetGroups() {
  const { can } = useApp();
  return useQuery<{ groups: FleetGroup[] }>(can('technician') ? '/fleet/groups' : null, ['devices'], 60_000);
}

/** A computer's group as a small tag (or the organization default). */
export function GroupTag({ name, color }: { name: string | null; color?: string | null }) {
  const { locale } = useI18n();
  const tx = policyText(locale);
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-[4px] border border-line bg-raised px-1.5 text-[11px] leading-none text-muted" dir="auto">
      <span className="size-2 shrink-0 rounded-full" style={{ background: color ?? 'var(--line-strong)' }} aria-hidden />
      {name ?? tx.orgDefault}
    </span>
  );
}

/** POST /fleet/groups/assign for one or more computers (admins). */
async function assign(endpointIds: string[], groupId: string | null) {
  await api('/fleet/groups/assign', { method: 'POST', body: { endpoint_ids: endpointIds, fleet_group_id: groupId } });
}

/** The bulk bar over the endpoint list: move the selected computers to a group, or out of any. */
export function GroupAssignBar({ selected, groups, onDone, onClear }: { selected: string[]; groups: FleetGroup[]; onDone: () => void; onClear: () => void }) {
  const { locale } = useI18n();
  const tx = policyText(locale);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function apply() {
    setBusy(true);
    setNote(null);
    try {
      await assign(selected, target === 'none' ? null : target);
      setNote({ ok: true, text: tx.assigned(selected.length) });
      onDone();
    } catch (err) {
      setNote({ ok: false, text: codeMessage(tx, err instanceof ApiError ? err : null) ?? String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/30 bg-accent/[0.06] px-3 py-2 text-sm">
      <span className="font-medium">{tx.selected(selected.length)}</span>
      <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label={tx.assignTo} className="w-64">
        <option value="" disabled>
          {tx.assignTo}
        </option>
        <option value="none">{tx.noGroup}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="primary" busy={busy} disabled={!target || selected.length === 0} onClick={() => void apply()}>
        {tx.assign}
      </Button>
      <Button size="sm" onClick={onClear}>
        {tx.clear}
      </Button>
      {note && (
        <span role="status" className={note.ok ? 'text-ok' : 'text-crit'}>
          {note.text}
        </span>
      )}
    </div>
  );
}

/** The group picker on an endpoint's detail page: admins change it, others read it. */
export function EndpointGroupPicker({ endpointId, groupId, groupName, onChanged }: { endpointId: string; groupId: string | null; groupName: string | null; onChanged: () => void }) {
  const { locale } = useI18n();
  const tx = policyText(locale);
  const { can } = useApp();
  const groups = useFleetGroups();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = groups.data?.groups ?? [];
  const color = list.find((g) => g.id === groupId)?.color ?? null;

  if (!can('admin')) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
        {tx.group}: <GroupTag name={groupName} color={color} />
      </span>
    );
  }

  async function change(v: string) {
    setBusy(true);
    setError(null);
    try {
      await assign([endpointId], v === 'none' ? null : v);
      onChanged();
    } catch (err) {
      setError(codeMessage(tx, err instanceof ApiError ? err : null) ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted">
      <label htmlFor={`grp-${endpointId}`}>{tx.group}</label>
      <Select id={`grp-${endpointId}`} value={groupId ?? 'none'} disabled={busy || groups.loading} onChange={(e) => void change(e.target.value)} className="h-8 w-60">
        <option value="none">{tx.noGroup}</option>
        {list.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </Select>
      {error && (
        <span role="alert" className="text-crit">
          {error}
        </span>
      )}
    </span>
  );
}
