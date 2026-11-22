'use client';

import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, ErrorNote, Field, Modal, Select, type Tone, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { controlText } from '../control-text';
import type { DeviceQuarantine as DeviceQuarantineState, Quarantine } from '../control-types';
import { RiskList } from './port-actions';

/** Auto-release choices offered in the dialog (minutes after the verified move); the API accepts 5 min – 30 days. */
const AUTO_RELEASE_CHOICES = [60, 240, 480, 1440, 4320, 10080] as const;
const minutesLabel = (m: number) => ltr(m % 1440 === 0 ? `${m / 1440} d` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);

const TONE: Record<Quarantine['status'], Tone> = { requested: 'info', active: 'warn', failed: 'crit', releasing: 'info', released: 'idle' };

/** Device page → quarantine: move the device's own switch port to the quarantine VLAN, and release it. */
export function DeviceQuarantine({ deviceId }: { deviceId: string }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  const { can } = useApp();
  const admin = can('admin');
  const q = useQuery<DeviceQuarantineState>(`/devices/${deviceId}/quarantine`, ['devices'], 15_000);
  const [dialog, setDialog] = useState<'quarantine' | 'release' | null>(null);
  if (!q.data) return null;
  const d = q.data;
  const cur = d.current;
  const plan = d.plan;
  const earlier = d.history.filter((h) => h.id !== cur?.id).slice(0, 3);
  // Nothing to add to what the port card already says (no MAC / not seen) and no quarantine ever: stay silent.
  if (!cur && !plan.possible && (plan.reason === 'no_mac' || plan.reason === 'not_located') && d.history.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg">
        <ShieldAlert className="size-3.5 text-muted" aria-hidden />
        {cx.quarantine}
      </p>
      {cur ? (
        <div className="space-y-1 text-[13px]">
          <p>
            <Badge tone={TONE[cur.status]}>{cx.quarantineStatus[cur.status]}</Badge>{' '}
            <span className="text-xs text-muted">{relativeTime(cur.activated_at ?? cur.created_at, locale)}</span>
          </p>
          <p className="text-xs text-muted" dir="auto">
            {fill(cx.portLine, { port: cur.port_name, switch: cur.switch_name })} · {fill(cx.vlanMove, { from: cur.original_vlan, to: cur.quarantine_vlan })}
          </p>
          {cur.reason && (
            <p className="text-xs text-muted" dir="auto">
              {cur.reason}
            </p>
          )}
          {cur.auto_release_minutes !== null && (cur.status === 'requested' || cur.status === 'active') && (
            <p className="text-xs text-muted">
              {cur.auto_release_at
                ? fill(cx.autoReleaseAt, { when: relativeTime(cur.auto_release_at, locale) })
                : fill(cx.autoReleaseAfterVerify, { after: minutesLabel(cur.auto_release_minutes) })}
            </p>
          )}
          {cur.last_error && <p className="text-xs text-crit" dir="auto">{cur.last_error}</p>}
          {admin && cur.status === 'active' && (
            <Button size="sm" onClick={() => setDialog('release')}>
              {cx.release}
            </Button>
          )}
        </div>
      ) : plan.possible ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted" dir="auto">
            {fill(cx.portLine, { port: plan.port_name ?? '', switch: plan.switch_name ?? '' })} · {fill(cx.vlanMove, { from: plan.current_vlan ?? '?', to: plan.quarantine_vlan ?? '?' })}
          </p>
          {admin && (
            <Button size="sm" variant="danger" onClick={() => setDialog('quarantine')}>
              {cx.quarantineAction}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">
          {cx.quarantineNot[plan.reason ?? ''] ?? plan.message}{' '}
          {(plan.reason === 'no_quarantine_vlan' || plan.reason === 'write_not_configured' || plan.reason === 'vlan_not_found') && (
            <Link href={plan.target_id ? `/radar/ports?switch=${plan.target_id}` : '/radar/ports'} className="text-accent hover:underline">
              {cx.setUpQuarantine}
            </Link>
          )}
        </p>
      )}
      {earlier.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">{cx.quarantineHistory}</summary>
          <ul className="mt-1 space-y-0.5">
            {earlier.map((h) => (
              <li key={h.id}>
                <Badge tone={TONE[h.status]} dot={false}>
                  {cx.quarantineStatus[h.status]}
                </Badge>{' '}
                {relativeTime(h.created_at, locale)} · {h.port_name} · VLAN {h.original_vlan} → {h.quarantine_vlan}
                {h.status === 'released' && h.auto_released && <> · {cx.autoReleased}</>}
                {h.last_error && <span className="block text-crit" dir="auto">{h.last_error}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {dialog && (
        <QuarantineDialog
          mode={dialog}
          deviceId={deviceId}
          data={d}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            q.reload();
          }}
        />
      )}
    </div>
  );
}

function QuarantineDialog({ mode, deviceId, data, onClose, onDone }: { mode: 'quarantine' | 'release'; deviceId: string; data: DeviceQuarantineState; onClose: () => void; onDone: () => void }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  const [reason, setReason] = useState('');
  const [releaseAfter, setReleaseAfter] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const cur = data.current;
  const plan = data.plan;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'quarantine') {
        await api(`/devices/${deviceId}/quarantine`, { method: 'POST', body: {
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(releaseAfter ? { release_after_minutes: Number(releaseAfter) } : {}),
            confirm: true,
          },
        });
      } else {
        await api(`/quarantines/${cur!.id}/release`, { method: 'POST', body: { confirm: true } });
      }
      onDone();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={mode === 'quarantine' ? cx.quarantineTitle : cx.releaseTitle} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-muted">{cx.quarantineIntro}</p>
        {mode === 'quarantine' ? (
          <>
            <p className="text-[13px]" dir="auto">
              {fill(cx.portLine, { port: plan.port_name ?? '', switch: plan.switch_name ?? '' })}
              <span className="block text-xs text-muted">{fill(cx.vlanMove, { from: plan.current_vlan ?? '?', to: plan.quarantine_vlan ?? '?' })}</span>
            </p>
            {plan.location && (
              <div className="text-xs text-muted">
                {cx.location}:
                <ul className="list-inside list-disc">
                  {plan.location.evidence.map((e, i) => (
                    <li key={i} dir="auto">
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.risks.length > 0 && <RiskList risks={data.risks} />}
            <Field label={cx.quarantineReason}>
              {(id) => <Textarea id={id} dir="auto" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <Field label={cx.autoRelease} hint={cx.autoReleaseHint}>
              {(id) => (
                <Select id={id} value={releaseAfter} onChange={(e) => setReleaseAfter(e.target.value)}>
                  <option value="">{cx.autoReleaseNever}</option>
                  {AUTO_RELEASE_CHOICES.map((m) => (
                    <option key={m} value={m}>
                      {cx.autoReleaseOptions[m]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        ) : (
          cur && (
            <p className="text-[13px]" dir="auto">
              {fill(cx.portLine, { port: cur.port_name, switch: cur.switch_name })}
              <span className="block text-xs text-muted">{fill(cx.vlanMove, { from: cur.quarantine_vlan, to: cur.original_vlan })}</span>
            </p>
          )
        )}
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" />
          <span>{mode === 'quarantine' ? cx.confirmQuarantine : cx.confirmRelease}</span>
        </label>
        <p className="text-[11px] text-faint">{fill(cx.queued, { min: data.ttl_minutes })}</p>
        {error && <ErrorNote error={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {cx.cancel}
          </Button>
          <Button type="submit" variant={mode === 'quarantine' ? 'danger' : 'primary'} busy={busy} disabled={!confirmed || (mode === 'quarantine' && data.risks.length > 0)}>
            {mode === 'quarantine' ? cx.quarantineAction : cx.release}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
