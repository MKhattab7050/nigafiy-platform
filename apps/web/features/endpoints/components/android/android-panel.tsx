'use client';

import { Camera, CameraOff, Check, Download, Eraser, Lock, PackageMinus, ShieldOff, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AndroidActionInput, AndroidActionRequest, AndroidActionResult, AndroidApk, AndroidPasswordComplexity, EndpointDetail } from '@nigafiy/shared-types';
import { Badge, Button, Card, ErrorNote, Fact, Field, Input, Notice, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { codeMessage, policyText } from '../fleet-policy/policy-text';
import { type AndroidText, androidText } from './android-text';

const COMPLEXITIES: AndroidPasswordComplexity[] = ['none', 'low', 'medium', 'high'];
const CODE_ERRORS = new Set(['policy_mfa_required', 'policy_mfa_invalid', 'invalid_mfa_code']);

/** A localized message for an API error (Android codes, then the Fleet policy codes, then the server's text). */
function errorText(ax: AndroidText, locale: string, err: ApiError): string {
  return ax.codes[err.code] ?? codeMessage(policyText(locale), err) ?? err.message;
}

/** What the Android agent reported (endpoints.android) and, in Device Owner mode, the actions. */
export function AndroidPanel({ ep, online, onReload }: { ep: EndpointDetail; online: boolean; onReload: () => void }) {
  const { locale } = useI18n();
  const ax = androidText(locale);
  const { can } = useApp();
  const a = ep.android;
  const owner = a?.mode === 'device_owner';
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [complexity, setComplexity] = useState<AndroidPasswordComplexity>(a?.password_complexity ?? 'medium');
  const [apkId, setApkId] = useState('');
  const [pkg, setPkg] = useState('');
  const [reason, setReason] = useState('');
  const apks = useQuery<{ apks: AndroidApk[] }>(can('technician') ? '/fleet/android/apks' : null, ['devices'], 0);
  const requests = useQuery<{ requests: AndroidActionRequest[] }>(`/endpoints/${ep.id}/android/requests`, ['devices'], 15_000);

  const userApps = ep.software.filter((s) => s.package_id && s.publisher !== 'system app' && s.package_id !== 'com.nigafiy.agent');

  async function run(key: string, body: AndroidActionInput, label: string, alwaysCode = false) {
    setBusy(key);
    setError(null);
    setNotice('');
    try {
      let step_up_token: string | undefined;
      if ((alwaysCode || needsCode) && code.length === 6) {
        step_up_token = (await api<{ step_up_token: string }>('/fleet/step-up', { method: 'POST', body: { code } })).step_up_token;
      }
      const res = await api<AndroidActionResult>(`/endpoints/${ep.id}/android/actions`, { method: 'POST', body: { ...body, ...(step_up_token ? { step_up_token } : {}) } });
      setNotice(res.state === 'queued' ? ax.queued(label) : ax.waiting);
      setCode('');
      setNeedsCode(false);
      if (key === 'wipe' || key === 'release') setReason('');
      onReload();
      requests.reload();
    } catch (err) {
      const e = err as ApiError;
      if (CODE_ERRORS.has(e.code)) setNeedsCode(true);
      setError(e);
    } finally {
      setBusy('');
    }
  }

  const codeInput = (
    <Field label={ax.code}>
      {(id) => (
        <Input
          id={id}
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          dir="ltr"
          className="mono w-32 tracking-[0.3em]"
        />
      )}
    </Field>
  );
  const disabled = !online || !owner;
  const codeOk = !needsCode || code.length === 6;

  return (
    <div className="space-y-5" data-testid="android-panel">
      <Card title={ax.panelTitle} description={a?.reported_at ? `${ax.reportedAt}: ${relativeTime(a.reported_at, locale)}` : undefined}>
        <dl>
          <Fact label={ax.mode}>
            {a ? <Badge tone={owner ? 'ok' : 'info'}>{ax.modes[a.mode] ?? a.mode}</Badge> : <span className="text-muted">{ax.modeUnknown}</span>}
          </Fact>
          <Fact label={ax.androidVersion}>{a ? ltr(`Android ${a.release ?? '?'} (API ${a.sdk_int})`) : '—'}</Fact>
          <Fact label={ax.patch}>{a?.security_patch ? <span className="mono">{ltr(a.security_patch)}</span> : <span className="text-muted">{ax.notMeasured}</span>}</Fact>
          <Fact label={ax.battery}>
            {typeof a?.battery_pct === 'number' ? `${ltr(`${a.battery_pct}%`)}${a.charging ? ` · ${ax.charging}` : ''}` : <span className="text-muted">{ax.notMeasured}</span>}
          </Fact>
          <Fact label={ax.network}>{a?.network ? (ax.networks[a.network] ?? a.network) : <span className="text-muted">{ax.notMeasured}</span>}</Fact>
          {owner && <Fact label={ax.camera}>{typeof a?.camera_disabled === 'boolean' ? (a.camera_disabled ? ax.cameraOff : ax.cameraOn) : <span className="text-muted">{ax.notMeasured}</span>}</Fact>}
          {owner && <Fact label={ax.passwordReq}>{a?.password_complexity ? ax.complexity[a.password_complexity] : <span className="text-muted">{ax.notMeasured}</span>}</Fact>}
          <Fact label={ax.batteryExempt}>
            {typeof a?.battery_optimisation_exempt === 'boolean' ? (a.battery_optimisation_exempt ? ax.exemptYes : <span className="text-warn">{ax.exemptNo}</span>) : <span className="text-muted">{ax.notMeasured}</span>}
          </Fact>
          <Fact label={ax.notifications}>
            {typeof a?.notifications_allowed === 'boolean' ? (a.notifications_allowed ? ax.notifYes : <span className="text-warn">{ax.notifNo}</span>) : <span className="text-muted">{ax.notMeasured}</span>}
          </Fact>
          <Fact label={ax.apps}>{typeof a?.apps_count === 'number' ? ltr(a.apps_count) : <span className="text-muted">{ax.notMeasured}</span>}</Fact>
        </dl>
      </Card>

      <Card title={ax.actionsTitle}>
        <div className="space-y-4 text-sm">
          {error && <ErrorNote error={new ApiError(error.status, error.code, errorText(ax, locale, error))} />}
          {notice && <Notice>{notice}</Notice>}
          {!can('technician') ? (
            <p className="text-[13px] text-muted">{ax.readOnly}</p>
          ) : !owner ? (
            <p className="text-[13px] text-muted">{ax.needsOwner}</p>
          ) : (
            <>
              {!online && <p className="text-[13px] text-warn">{ax.offline}</p>}
              {needsCode && (
                <div className="space-y-1">
                  <p className="text-xs text-muted">{ax.codeNeeded}</p>
                  {codeInput}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" busy={busy === 'lock'} disabled={disabled || !codeOk} onClick={() => window.confirm(ax.lockConfirm) && void run('lock', { action: 'lock' }, ax.lock)}>
                  <Lock className="size-3.5" aria-hidden />
                  {ax.lock}
                </Button>
                {a?.camera_disabled ? (
                  <Button size="sm" busy={busy === 'camera'} disabled={disabled || !codeOk} onClick={() => void run('camera', { action: 'camera', disabled: false }, ax.cameraEnable)}>
                    <Camera className="size-3.5" aria-hidden />
                    {ax.cameraEnable}
                  </Button>
                ) : (
                  <Button size="sm" busy={busy === 'camera'} disabled={disabled || !codeOk} onClick={() => void run('camera', { action: 'camera', disabled: true }, ax.cameraDisable)}>
                    <CameraOff className="size-3.5" aria-hidden />
                    {ax.cameraDisable}
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Field label={ax.passwordReq}>
                  {(id) => (
                    <Select id={id} value={complexity} onChange={(e) => setComplexity(e.target.value as AndroidPasswordComplexity)}>
                      {COMPLEXITIES.map((c) => (
                        <option key={c} value={c}>
                          {ax.complexity[c]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Button size="sm" busy={busy === 'password'} disabled={disabled || !codeOk} onClick={() => void run('password', { action: 'password_policy', complexity }, `${ax.passwordReq}: ${ax.complexity[complexity]}`)}>
                  <Check className="size-3.5" aria-hidden />
                  {ax.setRequirement}
                </Button>
              </div>

              {can('admin') && (
                <>
                  <div className="space-y-2 border-t border-line pt-4">
                    <h4 className="text-[13px] font-semibold">{ax.installTitle}</h4>
                    {(apks.data?.apks.length ?? 0) === 0 ? (
                      <p className="text-xs text-muted">{ax.noApks}</p>
                    ) : (
                      <div className="flex flex-wrap items-end gap-2">
                        <Field label={ax.installPick}>
                          {(id) => (
                            <Select id={id} value={apkId} onChange={(e) => setApkId(e.target.value)}>
                              <option value="">—</option>
                              {apks.data!.apks.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} ({p.file_name}, {(p.size_bytes / 1_048_576).toFixed(1)} MiB)
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>
                        <Button
                          size="sm"
                          busy={busy === 'install'}
                          disabled={disabled || !apkId || !codeOk}
                          onClick={() => void run('install', { action: 'install_apk', apk_id: apkId }, apks.data!.apks.find((p) => p.id === apkId)?.name ?? ax.install)}
                        >
                          <Download className="size-3.5" aria-hidden />
                          {ax.install}
                        </Button>
                      </div>
                    )}
                    <ApkUpload ax={ax} locale={locale} onUploaded={(name, repaired) => { setNotice(repaired ? ax.repaired(name) : ax.uploaded(name)); apks.reload(); }} onError={setError} />
                  </div>

                  <div className="space-y-2 border-t border-line pt-4">
                    <h4 className="text-[13px] font-semibold">{ax.removeTitle}</h4>
                    <div className="flex flex-wrap items-end gap-2">
                      {userApps.length > 0 && (
                        <Field label={ax.removePick}>
                          {(id) => (
                            <Select id={id} value={userApps.some((s) => s.package_id === pkg) ? pkg : ''} onChange={(e) => setPkg(e.target.value)}>
                              <option value="">—</option>
                              {userApps.map((s) => (
                                <option key={s.package_id} value={s.package_id!}>
                                  {s.name} ({s.package_id})
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>
                      )}
                      <Field label={ax.removePackage}>
                        {(id) => <Input id={id} value={pkg} onChange={(e) => setPkg(e.target.value.trim())} dir="ltr" className="mono" placeholder="com.example.app" maxLength={200} />}
                      </Field>
                      <Button
                        size="sm"
                        variant="danger"
                        busy={busy === 'uninstall'}
                        disabled={disabled || !pkg || !codeOk}
                        onClick={() => window.confirm(ax.removeConfirm(pkg)) && void run('uninstall', { action: 'uninstall', package: pkg }, `${ax.remove} ${ltr(pkg)}`)}
                      >
                        <PackageMinus className="size-3.5" aria-hidden />
                        {ax.remove}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2 border-t border-line pt-4">
                    <h4 className="text-[13px] font-semibold">{ax.dangerTitle}</h4>
                    <p className="text-xs text-muted">{ax.dangerBody}</p>
                    <div className="flex flex-wrap items-end gap-2">
                      <Field label={ax.reason}>
                        {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="w-72" />}
                      </Field>
                      {!needsCode && codeInput}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="danger"
                        busy={busy === 'wipe'}
                        disabled={disabled || reason.trim().length < 3 || code.length !== 6}
                        onClick={() => window.confirm(ax.wipeConfirm) && void run('wipe', { action: 'wipe', reason: reason.trim() }, ax.wipe, true)}
                      >
                        <Eraser className="size-3.5" aria-hidden />
                        {ax.wipe}
                      </Button>
                      <Button
                        size="sm"
                        busy={busy === 'release'}
                        disabled={disabled || reason.trim().length < 3 || code.length !== 6}
                        onClick={() => window.confirm(ax.releaseConfirm) && void run('release', { action: 'release', reason: reason.trim() }, ax.release, true)}
                      >
                        <ShieldOff className="size-3.5" aria-hidden />
                        {ax.release}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Card>

      <AndroidRequestsCard requests={requests.data?.requests ?? []} onChanged={() => { requests.reload(); onReload(); }} showPhone={false} />
    </div>
  );
}

function ApkUpload({ ax, locale, onUploaded, onError }: { ax: AndroidText; locale: string; onUploaded: (name: string, repaired: boolean) => void; onError: (e: ApiError) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function upload() {
    const f = file.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const q = new URLSearchParams({ name: name.trim() || f.name.replace(/\.apk$/i, ''), file_name: f.name });
      const res = await fetch(`/api/v1/fleet/android/apks?${q}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-LD-CSRF': '1', 'Content-Type': 'application/vnd.android.package-archive' },
        body: f,
      });
      const json = (await res.json().catch(() => null)) as { apk?: AndroidApk; repaired?: boolean; error?: { code: string; message: string } } | null;
      if (!res.ok || !json?.apk) {
        const e = json?.error ?? { code: 'upload_failed', message: `HTTP ${res.status}` };
        const err = new ApiError(res.status, e.code, e.message);
        onError(new ApiError(res.status, e.code, errorText(ax, locale, err)));
        return;
      }
      setName('');
      if (file.current) file.current.value = '';
      onUploaded(json.apk.name, json.repaired === true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={ax.uploadTitle}>{(id) => <input id={id} ref={file} type="file" accept=".apk,application/vnd.android.package-archive" className="text-xs" />}</Field>
      <Field label={ax.uploadName}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
      <Button size="sm" busy={busy} onClick={() => void upload()}>
        <Upload className="size-3.5" aria-hidden />
        {ax.upload}
      </Button>
    </div>
  );
}

/** Erase / stop-management requests; admins decide on other admins' requests here. */
export function AndroidRequestsCard({ requests, onChanged, showPhone }: { requests: AndroidActionRequest[]; onChanged: () => void; showPhone: boolean }) {
  const { locale } = useI18n();
  const ax = androidText(locale);
  const { can, me } = useApp();
  const meId = me.user.id;
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  async function decide(id: string, decision: 'approve' | 'deny') {
    setBusy(`${decision}-${id}`);
    setError(null);
    try {
      await api(`/fleet/android/requests/${id}/${decision}`, { method: 'POST', body: note.trim() ? { note: note.trim() } : {} });
      setNote('');
      onChanged();
    } catch (err) {
      const e = err as ApiError;
      setError(new ApiError(e.status, e.code, errorText(ax, locale, e)));
    } finally {
      setBusy('');
    }
  }
  return (
    <Card title={ax.requestsTitle}>
      <div className="space-y-3 text-sm" data-testid="android-requests">
        {error && <ErrorNote error={error} />}
        {requests.length === 0 ? (
          <p className="text-[13px] text-muted">{ax.noRequests}</p>
        ) : (
          <ul className="divide-y divide-line">
            {requests.map((r) => {
              const own = r.requested_by === meId;
              return (
                <li key={r.id} className="space-y-1.5 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={r.state === 'pending' ? 'warn' : r.state === 'approved' ? 'ok' : 'idle'}>{ax.requestState[r.state] ?? r.state}</Badge>
                    <span className="font-medium">{ax.actionLabel[r.action] ?? r.action}</span>
                    {showPhone && <span className="text-muted">· {ax.phone}: {r.endpoint_name}</span>}
                  </div>
                  <p className="text-xs text-muted" dir="auto">
                    “{r.reason}” · {ax.requestedBy(r.requested_email)} · {relativeTime(r.created_at, locale)}
                    {r.state === 'pending' ? ` · ${ax.expires} ${relativeTime(r.expires_at, locale)}` : r.approver_email ? ` · ${ax.decidedBy(r.approver_email)}` : ''}
                    {r.decision_note ? ` · “${r.decision_note}”` : ''}
                  </p>
                  {r.state === 'pending' && can('admin') && (
                    own ? (
                      <p className="text-xs text-muted">{ax.ownRequest}</p>
                    ) : (
                      <div className="flex flex-wrap items-end gap-2">
                        <Field label={ax.note}>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}</Field>
                        <Button size="sm" variant="danger" busy={busy === `approve-${r.id}`} onClick={() => void decide(r.id, 'approve')}>
                          <Check className="size-3.5" aria-hidden />
                          {ax.approve}
                        </Button>
                        <Button size="sm" busy={busy === `deny-${r.id}`} onClick={() => void decide(r.id, 'deny')}>
                          <X className="size-3.5" aria-hidden />
                          {ax.deny}
                        </Button>
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
