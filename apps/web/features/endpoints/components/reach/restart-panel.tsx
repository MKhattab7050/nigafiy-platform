'use client';

import { Power, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FleetBootState, FleetRestart, RemoteDesktopSession } from '@nigafiy/shared-types';
import { Button, Card, Field, Input, Notice } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { codeMessage, policyText } from '../fleet-policy/policy-text';
import { reachText } from './reach-text';

const ACTIVE = new Set(['queued', 'restarting']);
/** A finished restart stays on screen this long. */
const SHOW_DONE_MS = 15 * 60_000;

/**
 * Restart and reconnect (the session holder, profile "restart"): normal, or Safe Mode with
 * Networking on Windows with the agent installed as a service. The console polls the restart; the
 * API resumes the session when the agent is back, and safe boot is always cleared.
 */
export function RestartPanel({
  endpoint,
  live,
  allowed,
  canControl,
  onResumed,
}: {
  endpoint: { id: string; platform: string; boot_state?: FleetBootState };
  live: boolean;
  /** The session's profile allows restarting. */
  allowed: boolean;
  canControl: boolean;
  onResumed: () => void;
}) {
  const { locale } = useI18n();
  const tx = reachText(locale);
  const px = policyText(locale);
  const [restart, setRestart] = useState<FleetRestart | null>(null);
  const [mode, setMode] = useState<'normal' | 'safe_mode' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const safeOk = endpoint.platform === 'windows' && endpoint.boot_state?.service === true;

  const poll = useCallback(async () => {
    if (!canControl) return;
    try {
      const r = await api<{ restart: FleetRestart | null; session: RemoteDesktopSession | null }>(`/endpoints/${endpoint.id}/remote-desktop/restart`);
      setRestart(r.restart);
      if (r.session) onResumed();
    } catch {
      /* the next poll tries again */
    }
  }, [endpoint.id, canControl, onResumed]);

  useEffect(() => {
    void poll();
  }, [poll]);
  const active = restart ? ACTIVE.has(restart.state) : false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void poll(), 3_000);
    return () => clearInterval(t);
  }, [active, poll]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!mode || reason.trim().length < 3) return;
    if (!window.confirm(tx.restartConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ restart: FleetRestart }>(`/endpoints/${endpoint.id}/remote-desktop/restart`, { method: 'POST', body: { mode, reason: reason.trim() } });
      setRestart(r.restart);
      setMode(null);
      setReason('');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy(false);
    }
  }

  const recent = restart && (active || Date.now() - new Date(restart.decided_at ?? restart.created_at).getTime() < SHOW_DONE_MS);
  const showControls = canControl && live && allowed && !active;
  if (!recent && !showControls) return null;

  return (
    <Card title={tx.restartTitle} description={tx.restartHint}>
      <div className="space-y-3">
        {restart && recent && (
          <Notice className={restart.state === 'failed' || restart.state === 'timeout' ? 'border-crit/30 bg-crit/[0.07]' : undefined}>
            <span className="block">
              {tx.restartState[restart.state] ?? restart.state}
              {restart.error ? ` ${restart.error}` : ''}
            </span>
            {restart.mode === 'safe_mode' && restart.safe_boot_set && (
              <span className="mt-1 block text-xs">{restart.safe_boot_cleared_at ? tx.safeBootCleared : tx.safeBootPending}</span>
            )}
          </Notice>
        )}
        {showControls && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setMode('normal')} className={mode === 'normal' ? 'border-accent' : undefined}>
                <Power className="size-3.5" aria-hidden />
                {tx.restartNormal}
              </Button>
              <Button size="sm" disabled={!safeOk} title={safeOk ? tx.restartSafeHint : tx.restartSafeUnavailable} onClick={() => setMode('safe_mode')} className={mode === 'safe_mode' ? 'border-accent' : undefined}>
                <Power className="size-3.5" aria-hidden />
                {tx.restartSafe}
              </Button>
            </div>
            <p className="text-xs text-muted">{safeOk ? tx.restartSafeHint : tx.restartSafeUnavailable}</p>
            {mode && (
              <form onSubmit={send} className="flex flex-wrap items-end gap-2">
                <div className="min-w-64 flex-1">
                  <Field label={tx.restartReason}>{(id) => <Input id={id} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} dir="auto" autoFocus />}</Field>
                </div>
                <Button type="submit" variant="danger" busy={busy} disabled={reason.trim().length < 3}>
                  {tx.restartSend}
                </Button>
                <Button type="button" onClick={() => setMode(null)}>
                  {tx.cancel}
                </Button>
              </form>
            )}
          </>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-crit" aria-hidden />
            <span>{codeMessage(px, error)}</span>
          </div>
        )}
      </div>
    </Card>
  );
}
