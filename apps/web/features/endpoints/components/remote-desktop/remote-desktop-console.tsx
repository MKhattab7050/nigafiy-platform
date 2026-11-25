'use client';

import clsx from 'clsx';
import { ClipboardCopy, ClipboardPaste, Hourglass, Keyboard, Maximize2, Monitor, MousePointer, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import { Badge, Button, Card, ErrorNote, Input, Notice, Select, Textarea, type Tone } from '@/components/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/app';
import { ltr } from '@/lib/localize/bidi';
import { ConnectDialog } from '../fleet-policy/connect-dialog';
import { PermissionChips } from '../fleet-policy/permission-chips';
import { policyText } from '../fleet-policy/policy-text';
import { reachText } from '../reach/reach-text';
import { RestartPanel } from '../reach/restart-panel';
import { bytes, rdText } from './rd-text';
import { SessionHistory } from './session-history';
import { AnnotationLayer, ChatCard, OperatorsCard, SessionToolbar, TransferCard, WakeCard } from './session-tools-panel';
import { type RdPath, type RemoteDesktopConsoleProps, useRemoteDesktop } from './use-remote-desktop';
import { useSessionTools } from './use-session-tools';

const PATH_TONE: Record<RdPath, Tone> = { connecting: 'idle', direct: 'ok', relay: 'ok', waiting: 'warn', http: 'warn' };

export function RemoteDesktopConsole(props: RemoteDesktopConsoleProps) {
  const { ep, online, canControl, viewOnly = false, autoConnect = false, onReload } = props;
  const rd = useRemoteDesktop(props);
  const { me } = useApp();
  const tools = useSessionTools(rd, ep.id, me.user.id);
  const [wakeOpen, setWakeOpen] = useState(false);
  const tx = rdText(rd.locale);
  const px = policyText(rd.locale);
  const rx = reachText(rd.locale);
  const { reloadStatus, setConnectOpen } = rd;
  const onResumed = useCallback(() => {
    void reloadStatus();
    onReload();
  }, [reloadStatus, onReload]);
  // ?connect=1 (connect by name, Nigafiy ID or code; the Hub search): the connect dialog opens once.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoConnect || autoOpened.current || !online || !canControl || rd.session) return;
    autoOpened.current = true;
    setConnectOpen(true);
  }, [autoConnect, online, canControl, rd.session, setConnectOpen]);
  const waitingApproval = rd.state === 'waiting_approval';
  const waitingConsent = rd.state === 'waiting_consent';
  const refuseWindow = waitingConsent && fsRefuse(rd.fleetSession);
  const fs = rd.fleetSession;
  const policyPrompt = ep.policy?.remote_desktop_consent === 'prompt';
  const deniedPermissions = Object.entries(rd.hello?.desktop?.permissions ?? {}).filter(([, v]) => v === 'denied');

  const endedText = (() => {
    const s = rd.lastEnded;
    if (!s?.end_reason) return null;
    const e = tx.ended;
    switch (s.end_reason) {
      case 'operator':
        return e.operator(s.ended_by_email);
      case 'consent_unavailable':
        return e.consent_unavailable(s.consent_error);
      default:
        return e[s.end_reason];
    }
  })();

  return (
    <div className="space-y-4">
      {rd.error && <ErrorNote error={rd.error} />}

      {/* Transparency: the user sees who is connected, for the whole session. */}
      <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-line bg-raised/60 px-3.5 py-2.5 text-xs">
        <div className="flex min-w-0 flex-[1_1_20rem] flex-wrap items-center gap-2">
          <Badge tone={rd.live ? 'ok' : rd.state ? 'warn' : 'idle'}>{rd.live ? tx.live : waitingApproval ? px.waitingApproval : waitingConsent ? tx.waitingConsent : tx.idle}</Badge>
          <span className="flex items-start gap-1.5 text-muted">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {tx.transparency} {policyPrompt ? tx.promptPolicy : tx.unattendedPolicy}
            </span>
          </span>
        </div>
        {rd.session && (
          <div className="flex flex-wrap items-center gap-1.5">
            {rd.live && <Badge tone={PATH_TONE[rd.path]}>{tx.path[rd.path]}</Badge>}
            {rd.live && rd.wsLive && rd.rtc.mode !== 'off' && (
              <Badge tone={rd.rtc.active ? 'ok' : rd.rtc.mode === 'starting' ? 'idle' : 'info'}>
                {rd.rtc.active ? tx.rtc.active : rd.rtc.mode === 'starting' ? tx.rtc.starting : tx.rtc.compat}
              </Badge>
            )}
            {fs && fs.banner_state !== 'pending' && <Badge tone={fs.banner_state === 'shown' ? 'ok' : 'warn'}>{tx.banner[fs.banner_state]}</Badge>}
            {rd.hello?.desktop?.mode && <Badge tone="info">{tx.desktopMode[rd.hello.desktop.mode] ?? rd.hello.desktop.mode}</Badge>}
            {rd.session.user_session && <Badge tone="info">{rd.session.user_session === 'winlogon' ? rx.userSessionWinlogon : `${rx.userSession} ${ltr(rd.session.user_session)}`}</Badge>}
            {rd.session.quick_support && <Badge tone="warn">{rx.qsPanel}</Badge>}
          </div>
        )}
        {/* What this session's profile allows: the same list the user sees on the session bar. */}
        {rd.session && rd.permissions && (
          <div className="flex w-full flex-wrap items-center gap-2 border-t border-line pt-2">
            <span className="text-muted" dir="auto">
              {px.allowed}
              {rd.session.profile_name ? ` (${rd.session.profile_name})` : ''}:
            </span>
            <PermissionChips permissions={rd.permissions} />
          </div>
        )}
      </div>

      {rd.live && rd.path !== 'connecting' && rd.path !== 'direct' && <p className="text-xs text-muted">{tx.pathHelp[rd.path]}</p>}
      {fs?.banner_state === 'unavailable' && fs.banner_error && <Notice className="border-warn/30 bg-warn/[0.08]">{`${tx.banner.unavailable}: ${fs.banner_error}`}</Notice>}
      {deniedPermissions.map(([k]) => (
        <Notice key={k} className="border-warn/30 bg-warn/[0.08]">
          {tx.permissionDenied(tx.permissionNames[k] ?? k)}
        </Notice>
      ))}
      {rd.streamNote && <Notice className="border-warn/30 bg-warn/[0.08]">{rd.streamNote}</Notice>}
      {rd.live && rd.wsLive && rd.rtc.mode === 'jpeg' && rd.rtc.reason && (
        <Notice className="flex flex-wrap items-center justify-between gap-2">
          <span>{tx.rtc.fellBack(tx.rtc.reasons[rd.rtc.reason] ?? rd.rtc.reason)}</span>
          {rd.rtc.reason !== 'no_rtc' && rd.rtc.reason !== 'no_h264' && rd.rtc.reason !== 'recording' && (
            <Button size="sm" onClick={rd.rtc.retry}>
              {tx.rtc.retry}
            </Button>
          )}
        </Notice>
      )}
      {rd.live && rd.wsLive && rd.hello?.webrtc && !rd.hello.webrtc.supported && rd.hello.webrtc.reason && <p className="text-xs text-muted">{tx.rtc.unavailable(rd.hello.webrtc.reason)}</p>}
      {rd.live && rd.recording && rd.hello?.webrtc?.supported && <p className="text-xs text-muted">{tx.rtc.recording}</p>}
      {!rd.session && endedText && <Notice>{endedText}</Notice>}

      <Card
        title={tx.title}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {rd.displays.length > 0 && (
              <Select value={String(rd.displayIndex)} onChange={(e) => rd.setDisplayIndex(Number(e.target.value))} aria-label={tx.display}>
                {rd.displays.map((d) => (
                  <option key={d.index} value={d.index}>
                    {d.all ? tx.allDisplays : d.name}
                    {d.width > 0 && d.height > 0 ? ` (${ltr(`${d.width}×${d.height}`)})` : ''}
                  </option>
                ))}
              </Select>
            )}
            <Select value={String(rd.scale)} onChange={(e) => rd.setScale(Number(e.target.value))} aria-label={tx.scale}>
              {[0.5, 0.75, 1].map((s) => (
                <option key={s} value={s}>{`${tx.scale} ${ltr(`${s * 100}%`)}`}</option>
              ))}
            </Select>
            <Select value={String(rd.quality)} onChange={(e) => rd.setQuality(Number(e.target.value))} aria-label={tx.quality}>
              {[45, 68, 85].map((q) => (
                <option key={q} value={q}>{`${tx.quality} ${ltr(q)}`}</option>
              ))}
            </Select>
            <label className="flex items-center gap-1.5 px-1 text-xs text-muted" title={tx.adaptiveHint}>
              <input type="checkbox" checked={rd.adaptive} onChange={(e) => rd.setAdaptive(e.target.checked)} />
              {tx.adaptive}
            </label>
            {rd.hello?.webrtc?.supported && (
              <label className="flex items-center gap-1.5 px-1 text-xs text-muted" title={tx.rtc.toggleHint}>
                <input type="checkbox" checked={rd.rtc.preferred} onChange={(e) => (e.target.checked ? rd.rtc.retry() : rd.rtc.setPreferred(false))} />
                {tx.rtc.toggle}
              </label>
            )}
            {canControl && !viewOnly && rd.live && rd.allows('control') && (
              <Button size="sm" onClick={() => rd.setInteractive((v) => !v)} className={clsx(rd.interactive && 'border-accent text-fg')}>
                <MousePointer className="size-3.5" aria-hidden />
                {rd.interactive ? tx.control : tx.viewOnly}
              </Button>
            )}
            <Button size="sm" disabled={!online || !rd.live} onClick={rd.requestFull} title={tx.snapshot} aria-label={tx.snapshot}>
              <RefreshCw className="size-3.5" aria-hidden />
            </Button>
            <Button size="sm" onClick={() => void enterFullscreen(rd.viewportRef.current)} title={tx.fullscreen} aria-label={tx.fullscreen}>
              <Maximize2 className="size-3.5" aria-hidden />
            </Button>
            {!rd.session ? (
              <Button size="sm" variant="primary" disabled={!online || !canControl} busy={rd.busy === 'start'} onClick={() => rd.setConnectOpen(true)}>
                <Play className="size-3.5" aria-hidden />
                {tx.start}
              </Button>
            ) : (
              <Button size="sm" variant="danger" busy={rd.busy === 'stop'} disabled={!canControl} onClick={() => void rd.stopSession()}>
                <Square className="size-3.5" aria-hidden />
                {tx.stop}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-3">
          {rd.live && <SessionToolbar rd={rd} t={tools} canControl={canControl} />}
          {canControl && !viewOnly && rd.live && rd.allows('control') && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-bg/60 p-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!rd.textToType) return;
                  void rd.sendInput({ kind: 'text', text: rd.textToType });
                  rd.setTextToType('');
                }}
                className="flex min-w-60 flex-1 items-center gap-1.5"
              >
                <Keyboard className="size-4 shrink-0 text-muted" aria-hidden />
                <Input value={rd.textToType} maxLength={240} onChange={(e) => rd.setTextToType(e.target.value)} placeholder={tx.typeText} />
                <Button type="submit" size="sm" disabled={!online || !rd.textToType || !rd.mayControl}>
                  {tx.sendText}
                </Button>
              </form>
              <div className="flex flex-wrap items-center gap-1" dir="ltr">
                {(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const).map((k) => (
                  <Button key={k} size="sm" disabled={!rd.mayControl} onClick={() => void rd.sendInput({ kind: 'key_press', key: k })}>
                    {k.replace('Arrow', '')}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Screen */}
          <div
            ref={rd.viewportRef}
            role="application"
            aria-label={tx.title}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the remote screen takes keyboard focus to forward keys.
            tabIndex={0}
            onKeyDown={rd.onViewportKey}
            onKeyUp={rd.onViewportKeyUp}
            // Files dropped on the remote screen go to the destination folder (needs the files permission).
            onDragOver={(e) => {
              if (rd.live && canControl && tools.may('files')) e.preventDefault();
            }}
            onDrop={(e) => {
              if (!rd.live || !canControl || !tools.may('files')) return;
              e.preventDefault();
              void tools.uploadFiles(Array.from(e.dataTransfer.files), false);
            }}
            className="relative flex min-h-[420px] items-center justify-center overflow-hidden rounded-lg border border-line-strong bg-black focus:outline-2 focus:outline-accent"
          >
            <canvas
              ref={rd.canvasRef}
              className={clsx('max-h-[72vh] max-w-full select-none object-contain', !rd.hasPicture && 'hidden', rd.mayControl && 'cursor-crosshair')}
              aria-label={tx.title}
              {...rd.canvasHandlers}
            />
            {rd.live && rd.hasPicture && canControl && <AnnotationLayer rd={rd} t={tools} />}
            {!rd.hasPicture && (
              <div className="flex flex-col items-center gap-3 p-8 text-center text-white/70">
                {waitingConsent || waitingApproval ? <Hourglass className="size-10 text-warn" aria-hidden /> : <Monitor className="size-10 text-white/40" aria-hidden />}
                <p className="text-sm font-medium text-white" dir="auto">
                  {waitingApproval ? px.waitingApprovalTitle(ep.name) : waitingConsent ? tx.waitingTitle(ep.name) : rd.live ? tx.connecting : tx.readyTitle}
                </p>
                <p className="max-w-md text-xs">
                  {waitingApproval
                    ? px.waitingApprovalBody(rd.approvalLeft !== null ? ltr(`${Math.floor(rd.approvalLeft / 60)}:${String(rd.approvalLeft % 60).padStart(2, '0')}`) : null)
                    : refuseWindow
                      ? px.refuseWindowBody(rd.consentLeft ?? 0)
                      : waitingConsent
                        ? tx.waitingBody(rd.consentLeft ?? 60)
                        : rd.live
                          ? ''
                          : tx.readyBody}
                </p>
              </div>
            )}
          </div>

          {/* What the stream measures (from the agent), or the HTTP frame's own figures. */}
          {rd.live && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted mono">
              {rd.rtc.active && (
                <>
                  {rd.rtc.stats && <span>{tx.rtc.stats(rd.rtc.stats.fps, rd.rtc.stats.kbps)}</span>}
                  {rd.rtc.stats && rd.rtc.stats.width > 0 && <span>{ltr(`${rd.rtc.stats.width}×${rd.rtc.stats.height}`)}</span>}
                  {rd.rtc.stats?.targetKbps ? <span>{tx.rtc.target(rd.rtc.stats.targetKbps)}</span> : null}
                  {typeof rd.rtc.stats?.lossPct === 'number' && <span>{tx.rtc.loss(rd.rtc.stats.lossPct)}</span>}
                  {rd.rtc.encoder && <span dir="ltr">{rd.rtc.encoder}</span>}
                </>
              )}
              {rd.stats && rd.wsLive && !rd.rtc.active && (
                <>
                  <span>{tx.stats(rd.stats.fps, rd.stats.kbps, rd.stats.rtt_ms, rd.stats.quality, rd.stats.scale)}</span>
                  {rd.stats.width > 0 && <span>{ltr(`${rd.stats.width}×${rd.stats.height}`)}</span>}
                  <span>{tx.changed(rd.stats.changed_pct)}</span>
                  <span>{tx.viewers(rd.stats.viewers)}</span>
                </>
              )}
              {!rd.wsLive && rd.httpFrame && (
                <>
                  <span>{tx.size(rd.httpFrame.width, rd.httpFrame.height, rd.httpFrame.source_width, rd.httpFrame.source_height)}</span>
                  {!rd.httpFrame.unchanged && <span>{bytes(rd.httpFrame.byte_length)}</span>}
                  {rd.rttMs !== null && <span>RTT {ltr(`${rd.rttMs} ms`)}</span>}
                </>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Clipboard: text only, operator-initiated, audited. */}
      {canControl && rd.live && (rd.allows('clipboard_in') || rd.allows('clipboard_out')) && (
        <Card title={tx.clipboard}>
          <p className="mb-2 text-xs text-muted">{tx.clipboardHint}</p>
          {!rd.wsLive && <Notice className="border-warn/30 bg-warn/[0.08]">{tx.clipboardNeedsStream}</Notice>}
          <div className="grid gap-3 md:grid-cols-2">
            <div className={clsx('space-y-2', !rd.allows('clipboard_in') && 'hidden')}>
              <Textarea value={rd.clipOut} rows={3} onChange={(e) => rd.setClipOut(e.target.value)} placeholder={tx.clipboardSendPlaceholder} dir="auto" />
              {rd.clipOut.length > 16_000 && <p className="text-xs text-crit">{tx.tooLong}</p>}
              <Button size="sm" disabled={!rd.wsLive || !rd.clipOut || rd.clipOut.length > 16_000} onClick={rd.sendClipboard}>
                <ClipboardPaste className="size-3.5" aria-hidden />
                {tx.clipboardSend}
              </Button>
            </div>
            <div className={clsx('space-y-2', !rd.allows('clipboard_out') && 'hidden')}>
              <Textarea value={rd.clipIn ?? ''} rows={3} readOnly dir="auto" aria-label={tx.clipboardGet} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!rd.wsLive} onClick={rd.getClipboard}>
                  <ClipboardCopy className="size-3.5" aria-hidden />
                  {tx.clipboardGet}
                </Button>
                {rd.clipIn !== null && (
                  <Button size="sm" onClick={() => void navigator.clipboard?.writeText(rd.clipIn ?? '')}>
                    {tx.clipboardCopy}
                  </Button>
                )}
              </div>
            </div>
          </div>
          {rd.clipNote && (
            <p className={clsx('mt-2 text-xs', rd.clipNote.tone === 'ok' ? 'text-ok' : 'text-crit')}>
              {rd.clipNote.text === 'sent' ? tx.clipboardSent : rd.clipNote.text === 'needs_stream' ? tx.clipboardNeedsStream : rd.clipNote.text}
            </p>
          )}
        </Card>
      )}

      {rd.live && rd.session && <ChatCard t={tools} canControl={canControl} />}
      {rd.session && <OperatorsCard t={tools} meId={me.user.id} canControl={canControl} />}
      {rd.live && canControl && (tools.may('files') || tools.may('clipboard_in') || tools.may('clipboard_out')) && <TransferCard t={tools} perms={tools.perms} />}
      {!online && !rd.session && ep.status !== 'revoked' && <WakeCard t={tools} canControl={canControl} onWake={() => setWakeOpen(true)} />}
      <RestartPanel endpoint={ep} live={rd.live} allowed={rd.allows('restart')} canControl={canControl && !rd.session?.quick_support} onResumed={onResumed} />
      {wakeOpen && (
        <ConnectDialog
          endpoint={ep}
          onClose={() => setWakeOpen(false)}
          onSubmit={async (c) => {
            const refused = await tools.requestWake(c);
            if (!refused) setWakeOpen(false);
            return refused;
          }}
        />
      )}
      {rd.connectOpen && <ConnectDialog endpoint={ep} onClose={() => rd.setConnectOpen(false)} onSubmit={rd.requestSession} />}

      <SessionHistory endpointId={ep.id} />
    </div>
  );
}

/** Unattended with a refuse window: the person may refuse, no answer starts the session. */
function fsRefuse(fs: { consent_mode: string; refuse_window_s: number } | null): boolean {
  return Boolean(fs && fs.consent_mode !== 'prompt' && fs.refuse_window_s > 0);
}

/** Fullscreen, and Keyboard Lock where the browser has it, so Alt+Tab, Win and Esc reach the remote computer. */
async function enterFullscreen(el: HTMLElement | null) {
  if (!el?.requestFullscreen) return;
  await el.requestFullscreen();
  const kb = (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void> } }).keyboard;
  await kb?.lock?.().catch(() => undefined);
}
