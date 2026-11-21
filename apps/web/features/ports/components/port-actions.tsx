'use client';

import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Async, Badge, Button, ErrorNote, Field, Input, Modal, Notice, Segmented, Select, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { controlText } from '../control-text';
import type { PortControl, PortRisk } from '../control-types';
import { RequestHistory } from './request-history';

type Op = 'admin_status' | 'alias' | 'access_vlan';
const ALIAS_RE = /^[\x20-\x7e]*$/;

export function RiskList({ risks }: { risks: PortRisk[] }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  return (
    <div role="alert" className="rounded-[var(--radius-control)] border border-warn/30 bg-warn/[0.07] px-3 py-2.5 text-[13px]">
      <p className="flex items-center gap-1.5 font-medium text-warn">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        {cx.risksTitle}
      </p>
      <p className="mt-1 text-xs text-muted">{cx.risksIntro}</p>
      <ul className="mt-1.5 space-y-1">
        {risks.map((r) => (
          <li key={r.code} className="text-xs">
            <span className="font-medium text-fg">{cx.risk[r.code] ?? r.code}</span>{' '}
            <Badge tone={r.source === 'observed' ? 'ok' : 'info'} dot={false}>
              {cx.source[r.source]}
            </Badge>
            <span className="block text-muted" dir="auto">
              {r.evidence}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Port detail → "Change": enable / disable, description, access VLAN. Admin only (the API enforces it). */
export function PortActionsModal({ switchId, ifIndex, portName, onClose }: { switchId: string; ifIndex: number; portName: string; onClose: () => void }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  const q = useQuery<PortControl>(`/switches/${switchId}/ports/${ifIndex}/control`, ['devices'], 10_000);
  return (
    <Modal title={`${cx.manageTitle} · ${portName}`} onClose={onClose} wide>
      <Async query={q}>{(c) => <PortActionsBody c={c} onDone={q.reload} onClose={onClose} />}</Async>
    </Modal>
  );
}

function PortActionsBody({ c, onDone, onClose }: { c: PortControl; onDone: () => void; onClose: () => void }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  const ops: { value: Op; label: string }[] = [
    { value: 'admin_status', label: cx.adminState },
    { value: 'alias', label: cx.description },
    ...(c.actions.access_vlan.possible || c.actions.access_vlan.reason !== 'vlans_unknown' ? [{ value: 'access_vlan' as const, label: cx.accessVlan }] : []),
  ];
  const [op, setOp] = useState<Op>('admin_status');
  const [adminUp, setAdminUp] = useState(!c.port.admin_up);
  const [alias, setAlias] = useState(c.port.alias ?? '');
  const [vlan, setVlan] = useState('');
  const [override, setOverride] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const disruptive = (op === 'admin_status' && !adminUp) || op === 'access_vlan';
  const needsOverride = disruptive && c.risks.length > 0;
  const possible = c.actions[op];
  const valueReady = op === 'admin_status' ? adminUp !== c.port.admin_up : op === 'alias' ? alias.length <= 64 && ALIAS_RE.test(alias) && alias.trim() !== (c.port.alias ?? '') : Boolean(vlan);
  const ready = possible.possible && valueReady && confirmed && (!needsOverride || override.trim().length >= 10);
  const vlans = c.vlans.filter((v) => v.id !== c.port.vlan?.access_vlan);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        op === 'admin_status'
          ? { op, admin_up: adminUp, ...(needsOverride ? { override_reason: override.trim() } : {}), confirm: true }
          : op === 'alias'
            ? { op, alias, confirm: true }
            : { op, vlan: Number(vlan), ...(needsOverride ? { override_reason: override.trim() } : {}), confirm: true };
      await api(`/switches/${c.target_id}/ports/${c.if_index}/actions`, { method: 'POST', body });
      setNote(fill(cx.queued, { min: c.ttl_minutes }));
      setConfirmed(false);
      setOverride('');
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const v = c.port.vlan;
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">{cx.portControlIntro}</p>
      <dl className="grid gap-2 rounded-[var(--radius-control)] border border-line bg-sunken p-3 text-[13px] sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">{cx.adminState}</dt>
          <dd>{c.port.admin_up ? cx.enabled : cx.disabled}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">{cx.description}</dt>
          <dd className="truncate" dir="auto">
            {c.port.alias || '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{cx.accessVlan}</dt>
          <dd>{!v ? <span className="text-faint">{cx.vlanUnknown}</span> : v.mode === 'trunk' ? cx.trunkPort : v.access_vlan ? `VLAN ${v.access_vlan}` : cx.unknownMode}</dd>
        </div>
        <p className="text-[11px] text-faint sm:col-span-3">
          {cx.current} · {cx.readAt} {relativeTime(c.port.read_at, locale)}
          {v?.source && ` · ${cx.method[v.source] ?? v.source}`}
        </p>
      </dl>

      {c.pending && (
        <Notice>
          {cx.pending}: {c.pending.port_name} · {c.pending.op === 'access_vlan' ? `VLAN ${c.pending.params.vlan}` : c.pending.op}
        </Notice>
      )}
      {c.blocker && c.blocker !== 'change_pending' && <p className="text-[13px] text-warn">{cx.blocker[c.blocker] ?? c.blocker}</p>}
      {note && <p role="status" className="text-[13px] text-ok">{note}</p>}

      {!c.blocker && (
        <form onSubmit={submit} className="space-y-3">
          <Segmented value={op} options={ops} onChange={(x) => (setOp(x), setConfirmed(false))} label={cx.manageTitle} />
          {op === 'admin_status' && (
            <Segmented
              value={adminUp ? 'up' : 'down'}
              options={[
                { value: 'up', label: cx.enable },
                { value: 'down', label: cx.disable },
              ]}
              onChange={(x) => setAdminUp(x === 'up')}
              label={cx.adminState}
            />
          )}
          {op === 'alias' && (
            <Field label={cx.description} hint={cx.descriptionHint} error={alias && !ALIAS_RE.test(alias) ? cx.descriptionHint : undefined}>
              {(id) => <Input id={id} dir="ltr" value={alias} maxLength={64} onChange={(e) => setAlias(e.target.value)} />}
            </Field>
          )}
          {op === 'access_vlan' &&
            (possible.possible ? (
              <Field label={cx.moveVlan}>
                {(id) => (
                  <Select id={id} value={vlan} onChange={(e) => setVlan(e.target.value)}>
                    <option value="">{cx.chooseVlan}</option>
                    {vlans.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.id}
                        {x.name ? ` · ${x.name}` : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : (
              <p className="text-[13px] text-warn">{cx.blocker[possible.reason ?? ''] ?? possible.reason}</p>
            ))}
          {disruptive && c.risks.length > 0 && <RiskList risks={c.risks} />}
          {needsOverride && (
            <Field label={cx.overrideReason} hint={cx.overrideHint}>
              {(id) => <Textarea id={id} dir="auto" value={override} maxLength={500} onChange={(e) => setOverride(e.target.value)} />}
            </Field>
          )}
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" />
            <span>{cx.confirmCheck}</span>
          </label>
          {error && <ErrorNote error={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {cx.close}
            </Button>
            <Button type="submit" variant={disruptive ? 'danger' : 'primary'} busy={busy} disabled={!ready}>
              {cx.apply}
            </Button>
          </div>
        </form>
      )}
      {c.blocker && (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {cx.close}
          </Button>
        </div>
      )}
      <div className="rounded-[var(--radius-control)] border border-line">
        <p className="px-4 pt-3 text-xs font-medium text-fg">{cx.history}</p>
        <RequestHistory targetId={c.target_id} ifIndex={c.if_index} limit={10} />
      </div>
    </div>
  );
}
