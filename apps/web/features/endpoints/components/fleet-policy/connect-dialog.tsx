'use client';

import clsx from 'clsx';
import { Check, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import type { FleetBootState, FleetPolicyPreview, FleetUserSession } from '@nigafiy/shared-types';
import { Async, Button, Field, Input, Modal, Notice, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { reachText } from '../reach/reach-text';
import { toolsText } from '../remote-desktop/tools-text';
import { PermissionChips } from './permission-chips';
import { codeMessage, policyText, profileLabel } from './policy-text';

export interface ConnectChoice {
  reason: string;
  profile_id: string;
  step_up_token?: string;
  /** Asked for when the group's recording rule is "optional" (the API decides from the rule and profile). */
  recording_enabled?: boolean;
  /** Set by Wake-on-LAN then connect: the wake request this session completes. */
  wake_request_id?: string;
  /** Windows: the user session to attach to (a session id, or 'winlogon' for the sign-in screen). */
  user_session?: string;
}

/**
 * The connect dialog: the computer's access policy (advice: the request re-checks everything), a
 * required reason, the profile up to the policy's maximum, and the verification code when the
 * policy asks for one (exchanged for a short-lived step-up token first).
 */
export function ConnectDialog({
  endpoint,
  onClose,
  onSubmit,
}: {
  /** With the platform, the Windows sessions and the boot state, the dialog offers the session choice. */
  endpoint: { id: string; name: string; platform?: string; user_sessions?: FleetUserSession[]; boot_state?: FleetBootState };
  onClose: () => void;
  /** Sends the session request; resolves to the API's refusal, or null when the request went out. */
  onSubmit: (choice: ConnectChoice) => Promise<ApiError | null>;
}) {
  const { locale } = useI18n();
  const tx = policyText(locale);
  const query = useQuery<FleetPolicyPreview>(`/endpoints/${endpoint.id}/remote-desktop/policy`, ['devices'], 60_000);
  const [reason, setReason] = useState('');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [record, setRecord] = useState(false);
  const [userSession, setUserSession] = useState('');
  const rx = reachText(locale);
  const sessions = (endpoint.user_sessions ?? []).filter((s) => s.state !== 'listen');
  const canPickSession = endpoint.platform === 'windows';
  const asService = endpoint.boot_state?.service === true;
  const tt = toolsText(locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(p: FleetPolicyPreview, chosen: string) {
    setBusy(true);
    setError(null);
    try {
      let token: string | undefined;
      if (p.policy.mfa_required) {
        const r = await api<{ step_up_token: string }>('/fleet/step-up', { method: 'POST', body: { code: code.trim() } });
        token = r.step_up_token;
      }
      const recordAllowed = p.profiles.find((x) => x.id === chosen)?.record === true;
      const recording_enabled = p.recording_mode === 'required' || (p.recording_mode === 'optional' && record && recordAllowed);
      const refused = await onSubmit({ reason: reason.trim(), profile_id: chosen, recording_enabled, ...(token ? { step_up_token: token } : {}), ...(userSession ? { user_session: userSession } : {}) });
      if (refused) {
        setError(refused);
        void query.reload();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy(false);
      setCode('');
    }
  }

  return (
    <Modal title={tx.connectTitle(endpoint.name)} onClose={onClose} wide>
      <Async query={query}>
        {(p) => {
          const chosen = profileId && p.profiles.some((x) => x.id === profileId) ? profileId : (p.profiles.find((x) => x.id === p.default_profile_id)?.id ?? p.profiles[0]?.id ?? '');
          const profile = p.profiles.find((x) => x.id === chosen);
          const mfaBlocked = p.policy.mfa_required && !p.operator_has_mfa;
          const checks: { label: string; ok: boolean }[] = [
            { label: tx.checkRole, ok: p.role_allowed },
            { label: tx.checkIp(p.request_ip ? ltr(p.request_ip) : null), ok: p.ip_allowed },
            { label: tx.checkHours, ok: p.within_hours },
          ];
          const blocked = checks.some((c) => !c.ok) || mfaBlocked;
          const ready = !blocked && !(p.recording_mode === 'required' && profile?.record === false) && reason.trim().length >= 3 && Boolean(chosen) && (!p.policy.mfa_required || /^\d{6}$/.test(code.trim()));
          return (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (ready) void submit(p, chosen);
              }}
            >
              <div className="rounded-md border border-line bg-raised/60 p-3 text-xs">
                <p className="mb-2 font-medium text-fg" dir="auto">
                  {tx.policyFrom(p.group ? p.group.name : null)}
                </p>
                <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1" aria-label={tx.checks}>
                  {checks.map((c) => (
                    <li key={c.label} className={clsx('flex items-center gap-1', c.ok ? 'text-muted' : 'text-crit')}>
                      {c.ok ? <Check className="size-3.5 text-ok" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                      {c.label}: {c.ok ? tx.pass : tx.fail}
                    </li>
                  ))}
                </ul>
                <p className="text-muted">{p.policy.access_mode === 'attended' ? tx.modeAttended(p.policy.consent_timeout_s) : tx.modeUnattended(p.policy.refuse_window_s)}</p>
                {p.policy.access_mode === 'unattended' && <p className="text-muted">{tx.connectBanner[p.policy.banner_mode ?? 'shown']}</p>}
                {p.approval_needed && <p className="mt-1 text-warn">{tx.needsApproval(p.policy.approval_ttl_minutes)}</p>}
              </div>

              <Field label={tx.reason} hint={reason.trim().length > 0 && reason.trim().length < 3 ? tx.reasonShort : undefined}>
                {(id) => <Input id={id} value={reason} maxLength={200} required onChange={(e) => setReason(e.target.value)} placeholder={tx.reasonPlaceholder} dir="auto" autoFocus />}
              </Field>

              <Field label={tx.profile} hint={tx.profileHint(profileLabel(tx, p.max_profile))}>
                {(id) => (
                  <Select id={id} value={chosen} onChange={(e) => setProfileId(e.target.value)}>
                    {p.profiles.map((x) => (
                      <option key={x.id} value={x.id}>
                        {profileLabel(tx, x)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {profile && <PermissionChips permissions={profile} all />}

              {/* Windows: which user session, or the sign-in screen when nobody is signed in (needs the service). */}
              {canPickSession && (
                <Field label={rx.userSession} hint={asService ? (userSession === 'winlogon' ? rx.userSessionWinlogonNote : undefined) : rx.userSessionNeedsService}>
                  {(id) => (
                    <Select id={id} value={userSession} disabled={!asService} onChange={(e) => setUserSession(e.target.value)}>
                      <option value="">{rx.userSessionDefault}</option>
                      {sessions.map((s) => (
                        <option key={s.id} value={String(s.id)}>
                          {rx.userSessionItem(s.id, s.user ? (s.domain ? `${s.domain}\\${s.user}` : s.user) : null, s.state)}
                        </option>
                      ))}
                      <option value="winlogon">{rx.userSessionWinlogon}</option>
                    </Select>
                  )}
                </Field>
              )}

              {/* Recording follows the group's rule; the person always sees the recording mark. */}
              {p.recording_mode === 'optional' && profile?.record && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
                  {tt.recordThis(p.recording_retention_days)}
                </label>
              )}
              {p.recording_mode === 'required' && (
                <Notice className={profile?.record ? undefined : 'border-warn/30 bg-warn/[0.08]'}>{profile?.record ? tt.recordRequired(p.recording_retention_days) : tt.recordProfileCannot}</Notice>
              )}
              {p.recording_mode === 'off' && <p className="text-xs text-muted">{tt.recordOff}</p>}

              {p.policy.mfa_required &&
                (mfaBlocked ? (
                  <Notice className="border-warn/30 bg-warn/[0.08]">{tx.mfaNotEnrolled}</Notice>
                ) : (
                  <Field label={tx.mfaCode}>
                    {(id) => (
                      <Input
                        id={id}
                        value={code}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        pattern="\d{6}"
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                        dir="ltr"
                        className="mono w-36 tracking-[0.3em]"
                      />
                    )}
                  </Field>
                ))}

              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-[13px]">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-crit" aria-hidden />
                  <span>{codeMessage(tx, error)}</span>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button type="button" onClick={onClose}>
                  {tx.cancel}
                </Button>
                <Button type="submit" variant="primary" disabled={!ready} busy={busy}>
                  {tx.send}
                </Button>
              </div>
            </form>
          );
        }}
      </Async>
    </Modal>
  );
}
