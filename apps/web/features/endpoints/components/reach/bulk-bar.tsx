'use client';

import { useState } from 'react';
import type { FleetGroup } from '@nigafiy/shared-types';
import { Button, Input, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { GroupAssignBar } from '../fleet-policy/group-assign';
import { codeMessage, policyText } from '../fleet-policy/policy-text';
import { reachText } from './reach-text';

type Action = 'tags' | 'notify' | 'power' | 'wake' | 'refresh_inventory';
interface ItemResult {
  endpoint_id: string;
  ok: boolean;
  code?: string;
  message?: string;
}

const splitTags = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

/**
 * The address book's bulk bar: group (admins), tags (admins), a message, a power action, wake,
 * refresh. Every computer keeps its own role check and audit row on the server; each result is
 * listed here.
 */
export function BulkBar({
  selected,
  names,
  groups,
  canAdmin,
  onClear,
  onDone,
}: {
  selected: string[];
  names: Record<string, string>;
  groups: FleetGroup[] | null;
  canAdmin: boolean;
  onClear: () => void;
  onDone: () => void;
}) {
  const { locale } = useI18n();
  const tx = reachText(locale);
  const px = policyText(locale);
  const [action, setAction] = useState<Action | ''>('');
  const [add, setAdd] = useState('');
  const [remove, setRemove] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [power, setPower] = useState<'restart' | 'shutdown' | 'lock' | 'logoff'>('lock');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [results, setResults] = useState<ItemResult[]>([]);

  const ready =
    action === 'tags'
      ? splitTags(add).length + splitTags(remove).length > 0
      : action === 'notify'
        ? title.trim().length > 0 && message.trim().length > 0
        : action === 'power' || action === 'wake'
          ? reason.trim().length >= 3
          : action === 'refresh_inventory';

  async function apply() {
    if (!action || !ready) return;
    setBusy(true);
    setNote(null);
    setResults([]);
    try {
      if (action === 'tags') {
        await api('/fleet/address-book/tags', { method: 'POST', body: { endpoint_ids: selected, add: splitTags(add), remove: splitTags(remove) } });
        setNote({ ok: true, text: tx.tagsDone(selected.length) });
      } else {
        const body =
          action === 'notify'
            ? { action, endpoint_ids: selected, title: title.trim(), message: message.trim() }
            : action === 'power'
              ? { action, endpoint_ids: selected, power, reason: reason.trim() }
              : action === 'wake'
                ? { action, endpoint_ids: selected, reason: reason.trim() }
                : { action, endpoint_ids: selected };
        const r = await api<{ results: ItemResult[] }>('/fleet/bulk', { method: 'POST', body });
        const ok = r.results.filter((x) => x.ok).length;
        setNote({ ok: ok === r.results.length, text: tx.results(ok, r.results.length - ok) });
        setResults(r.results.filter((x) => !x.ok));
      }
      onDone();
    } catch (err) {
      setNote({ ok: false, text: codeMessage(px, err instanceof ApiError ? err : null) ?? String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {canAdmin && groups && <GroupAssignBar selected={selected} groups={groups} onClear={onClear} onDone={onDone} />}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/30 bg-accent/[0.06] px-3 py-2 text-sm">
        <span className="font-medium">{tx.selected(selected.length)}</span>
        <Select value={action} onChange={(e) => setAction(e.target.value as Action)} aria-label={tx.bulkAction} className="w-56">
          <option value="" disabled>
            {tx.bulkAction}
          </option>
          {canAdmin && <option value="tags">{tx.bulk.tags}</option>}
          <option value="notify">{tx.bulk.notify}</option>
          <option value="power">{tx.bulk.power}</option>
          <option value="wake">{tx.bulk.wake}</option>
          <option value="refresh_inventory">{tx.bulk.refresh_inventory}</option>
        </Select>
        {action === 'tags' && (
          <>
            <Input value={add} onChange={(e) => setAdd(e.target.value)} placeholder={tx.tagsAdd} aria-label={tx.tagsAdd} className="w-52" dir="auto" />
            <Input value={remove} onChange={(e) => setRemove(e.target.value)} placeholder={tx.tagsRemove} aria-label={tx.tagsRemove} className="w-52" dir="auto" />
          </>
        )}
        {action === 'notify' && (
          <>
            <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={tx.msgTitle} aria-label={tx.msgTitle} className="w-44" dir="auto" />
            <Input value={message} maxLength={600} onChange={(e) => setMessage(e.target.value)} placeholder={tx.msgBody} aria-label={tx.msgBody} className="w-72" dir="auto" />
          </>
        )}
        {action === 'power' && (
          <Select value={power} onChange={(e) => setPower(e.target.value as typeof power)} aria-label={tx.bulk.power} className="w-40" title={tx.powerAdminNote}>
            {(['lock', 'logoff', 'restart', 'shutdown'] as const).map((p) => (
              <option key={p} value={p}>
                {tx.power[p]}
              </option>
            ))}
          </Select>
        )}
        {(action === 'power' || action === 'wake') && (
          <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={tx.reason} aria-label={tx.reason} className="w-56" dir="auto" />
        )}
        <Button size="sm" variant="primary" busy={busy} disabled={!ready || selected.length === 0} onClick={() => void apply()}>
          {tx.apply}
        </Button>
        <Button size="sm" onClick={onClear}>
          {tx.clear}
        </Button>
        {note && (
          <span role="status" className={note.ok ? 'text-ok' : 'text-warn'}>
            {note.text}
          </span>
        )}
      </div>
      {action === 'power' && <p className="text-xs text-muted">{tx.powerAdminNote}</p>}
      {results.length > 0 && (
        <ul className="space-y-0.5 text-xs text-crit">
          {results.map((r) => (
            <li key={r.endpoint_id} dir="auto">
              {names[r.endpoint_id] ?? r.endpoint_id}: {codeMessage(px, { code: r.code ?? '', message: r.message ?? '' })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
