'use client';

import type { Terminal } from '@xterm/xterm';
import { SquareTerminal, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { FleetPolicyPreview, FleetShellSession } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, Field, Input, Modal, Notice, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { jobsError } from '../fleet-jobs/job-dialog';
import { jobsText } from '../fleet-jobs/jobs-text';
import { profileLabel, policyText } from '../fleet-policy/policy-text';
import { XtermView } from './xterm-view';

const shellSocketUrl = (endpointId: string, publicId: string) => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/v1/endpoints/${encodeURIComponent(endpointId)}/shell/stream?shell=${encodeURIComponent(publicId)}`;
};

/**
 * The endpoint page's remote shell (admins): open one (reason, a profile with "shell", the
 * verification code when the policy asks), the live terminal, End, and this computer's shells
 * with their transcripts. Technicians and viewers see why there is no button.
 */
export function ShellPanel({ endpoint }: { endpoint: { id: string; name: string; online: boolean } }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const { can } = useApp();
  const canAdmin = can('admin');
  const history = useQuery<{ shells: FleetShellSession[] }>(canAdmin ? `/fleet/shells?endpoint_id=${endpoint.id}&limit=20` : null, ['devices'], 15_000);
  const [opening, setOpening] = useState(false);
  const [live, setLive] = useState<FleetShellSession | null>(null);

  if (!canAdmin) {
    return (
      <Card title={tx.shellTitle}>
        <p className="text-sm text-muted">{tx.shellAdminOnly}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card
        title={tx.shellTitle}
        description={tx.shellSubtitle}
        action={
          !live ? (
            <Button variant="primary" size="sm" disabled={!endpoint.online} onClick={() => setOpening(true)}>
              <SquareTerminal className="size-3.5" aria-hidden />
              {tx.openShell}
            </Button>
          ) : undefined
        }
      >
        {live ? (
          <LiveShell
            endpointId={endpoint.id}
            shell={live}
            onGone={() => {
              setLive(null);
              void history.reload();
            }}
          />
        ) : (
          <p className="text-sm text-muted">{tx.transcriptNote}</p>
        )}
      </Card>
      <Card title={tx.shellsHistory} padded={false}>
        <Async query={history}>
          {({ shells }) =>
            shells.length === 0 ? (
              <p className="p-4 text-sm text-muted">{tx.noShells}</p>
            ) : (
              <ul className="divide-y divide-line">
                {shells.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                    <Badge tone={s.state === 'closed' ? 'idle' : 'ok'}>{tx.shellState[s.state]}</Badge>
                    <span>{tx.shellBy(s.operator_email, absoluteTime(s.created_at, locale))}</span>
                    <span className="text-muted" dir="auto">
                      {s.reason}
                    </span>
                    {s.end_reason && <span className="text-xs text-faint">{tx.endReason[s.end_reason]}</span>}
                    {s.exit_code !== null && <span className="mono text-xs text-faint">{tx.exited(s.exit_code)}</span>}
                    <Link href={`/fleet/endpoints/${endpoint.id}/shell/${s.id}`} className="ms-auto text-xs text-accent-hover hover:underline">
                      {tx.transcript}
                    </Link>
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
      </Card>
      {opening && (
        <OpenShellDialog
          endpoint={endpoint}
          onClose={() => setOpening(false)}
          onOpened={(s) => {
            setOpening(false);
            setLive(s);
            void history.reload();
          }}
        />
      )}
    </div>
  );
}

function OpenShellDialog({ endpoint, onClose, onOpened }: { endpoint: { id: string; name: string }; onClose: () => void; onOpened: (s: FleetShellSession) => void }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const px = policyText(locale);
  const q = useQuery<FleetPolicyPreview>(`/endpoints/${endpoint.id}/remote-desktop/policy`, ['devices'], 60_000);
  const [reason, setReason] = useState('');
  const [profileId, setProfileId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(p: FleetPolicyPreview, chosen: string) {
    setBusy(true);
    setError(null);
    try {
      let token: string | undefined;
      if (p.policy.mfa_required) token = (await api<{ step_up_token: string }>('/fleet/step-up', { method: 'POST', body: { code: code.trim() } })).step_up_token;
      const s = await api<FleetShellSession>(`/endpoints/${endpoint.id}/shell`, {
        method: 'POST',
        body: { reason: reason.trim(), profile_id: chosen, cols: 120, rows: 30, ...(token ? { step_up_token: token } : {}) },
      });
      onOpened(s);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy(false);
      setCode('');
    }
  }

  return (
    <Modal title={tx.openShellTitle(endpoint.name)} onClose={onClose} wide>
      <Async query={q}>
        {(p) => {
          const withShell = p.profiles.filter((x) => x.shell);
          const chosen = withShell.some((x) => x.id === profileId) ? profileId : (withShell[0]?.id ?? '');
          const ready = reason.trim().length >= 3 && Boolean(chosen) && (!p.policy.mfa_required || /^\d{6}$/.test(code.trim()));
          return (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (ready) void submit(p, chosen);
              }}
            >
              <Notice>{tx.transcriptNote}</Notice>
              <Field label={tx.shellReason}>
                {(id) => <Input id={id} value={reason} maxLength={200} required onChange={(e) => setReason(e.target.value)} placeholder={tx.shellReasonPlaceholder} dir="auto" autoFocus />}
              </Field>
              <Field label={tx.shellProfile} hint={withShell.length === 0 ? tx.codes.profile_forbids_shell : undefined}>
                {(id) => (
                  <Select id={id} value={chosen} onChange={(e) => setProfileId(e.target.value)} disabled={withShell.length === 0}>
                    {withShell.map((x) => (
                      <option key={x.id} value={x.id}>
                        {profileLabel(px, x)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {p.policy.mfa_required && (
                <Field label={tx.mfaCode} hint={tx.mfaHint}>
                  {(id) => <Input id={id} value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={6} onChange={(e) => setCode(e.target.value)} dir="ltr" />}
                </Field>
              )}
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
                  {tx.openShell}
                </Button>
              </div>
            </form>
          );
        }}
      </Async>
    </Modal>
  );
}

/** The live terminal: keystrokes go out as bytes, the output comes back as bytes, resizes as JSON. */
function LiveShell({ endpointId, shell, onGone }: { endpointId: string; shell: FleetShellSession; onGone: () => void }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const [status, setStatus] = useState<{ text: string; ended: boolean }>({ text: tx.shellConnecting, ended: false });
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ shell?: string; pty?: string }>({});

  const onReady = useCallback(
    (term: Terminal, fit: () => { cols: number; rows: number }) => {
      const ws = new WebSocket(shellSocketUrl(endpointId, shell.public_id));
      ws.binaryType = 'arraybuffer';
      const enc = new TextEncoder();
      const sendSize = () => {
        const { cols, rows } = fit();
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: Math.max(20, Math.min(400, cols)), rows: Math.max(5, Math.min(200, rows)) }));
      };
      ws.onopen = () => sendSize();
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(ev.data));
          return;
        }
        let m: { t?: string; state?: string; shell?: string; pty?: string; reason?: string } = {};
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.t === 'hello' || (m.t === 'state' && m.shell)) {
          setInfo({ shell: m.shell, pty: m.pty });
          setStatus({ text: '', ended: false });
        } else if (m.t === 'end') {
          setStatus({ text: tx.shellEnded(tx.endReason[m.reason as keyof typeof tx.endReason] ?? m.reason ?? ''), ended: true });
        }
      };
      ws.onclose = () => setStatus((s) => (s.ended ? s : { text: tx.shellEnded(tx.endReason.agent_gone), ended: true }));
      const data = term.onData((d) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
      });
      const resize = term.onResize(() => sendSize());
      return () => {
        data.dispose();
        resize.dispose();
        ws.close();
      };
    },
    [endpointId, shell.public_id, tx],
  );

  async function end() {
    setBusy(true);
    try {
      await api(`/endpoints/${endpointId}/shell/${shell.id}/close`, { method: 'POST', body: {} });
    } catch (err) {
      setStatus({ text: jobsError(tx, err instanceof ApiError ? err : null, locale) ?? String(err), ended: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span dir="auto">{shell.reason}</span>
        {info.shell && <span className="mono">{ltr(info.shell)}</span>}
        {info.pty && <span>{tx.ptyName[info.pty] ?? info.pty}</span>}
        <span>{tx.idle(shell.idle_timeout_s)}</span>
        <div className="ms-auto flex gap-1.5">
          {status.ended ? (
            <Button size="sm" onClick={onGone}>
              <X className="size-3.5" aria-hidden />
              {tx.close}
            </Button>
          ) : (
            <Button size="sm" busy={busy} onClick={() => void end()}>
              <X className="size-3.5" aria-hidden />
              {tx.endShell}
            </Button>
          )}
        </div>
      </div>
      {status.text && (
        <p role="status" className={status.ended ? 'text-sm text-warn' : 'text-sm text-muted'}>
          {status.text}
        </p>
      )}
      <XtermView onReady={onReady} label={tx.shellTitle} />
    </div>
  );
}
