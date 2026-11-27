'use client';

import { mediaPictureBox } from './picture-rect';
import clsx from 'clsx';
import {
  AppWindow,
  Ban,
  Check,
  CircleDot,
  Command,
  Crosshair,
  Download,
  Eraser,
  EyeOff,
  Files,
  Image,
  LogIn,
  LogOut,
  MessageSquare,
  Pencil,
  Power,
  Printer,
  Send,
  Upload,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { FleetPermissions } from '@nigafiy/shared-types';
import { Badge, Button, Card, ErrorNote, Input, Notice, Select } from '@/components/ui';
import { ltr } from '@/lib/localize/bidi';
import type { useRemoteDesktop } from './use-remote-desktop';
import type { AskItem, useSessionTools } from './use-session-tools';

type Rd = ReturnType<typeof useRemoteDesktop>;
type Tools = ReturnType<typeof useSessionTools>;

/**
 * The live-session toolbar: picture mode, colours, pointer, monitors, keyboard mapping, special
 * keys, SAS, privacy screen, input pause, sound, recording, drawing. Every button is shown only
 * when the session's (or this operator's) permissions allow it; the hub and the agent check again.
 */
export function SessionToolbar({ rd, t, canControl }: { rd: Rd; t: Tools; canControl: boolean }) {
  const { tx } = t;
  const monitors = rd.displays.filter((d) => !d.all);
  const control = canControl && t.may('control');
  return (
    <div className="space-y-2 rounded-md border border-line bg-bg/60 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">{tx.mode}</span>
        <Select value={t.qualityMode ?? ''} onChange={(e) => t.setQualityMode(e.target.value as 'best' | 'balanced' | 'fast')} aria-label={tx.mode}>
          {t.qualityMode === null && <option value="">—</option>}
          {(['best', 'balanced', 'fast'] as const).map((m) => (
            <option key={m} value={m}>
              {tx.modes[m]}
            </option>
          ))}
        </Select>
        {t.has('depth') && (
          <Select value={String(t.depth)} onChange={(e) => t.setDepth(Number(e.target.value) as 24 | 16 | 8)} aria-label={tx.depth}>
            {[24, 16, 8].map((d) => (
              <option key={d} value={d}>
                {tx.depths[d]}
              </option>
            ))}
          </Select>
        )}
        {rd.hello && (rd.hello as unknown as { cursor_supported?: boolean }).cursor_supported && (
          <label className="flex items-center gap-1.5 px-1 text-muted">
            <input type="checkbox" checked={t.cursor} onChange={(e) => t.setCursor(e.target.checked)} />
            {tx.cursor}
          </label>
        )}
        {monitors.length > 1 && rd.displays.some((d) => d.all) && (
          <Button size="sm" onClick={t.openMonitorWindows} title={tx.eachWindowHint}>
            <AppWindow className="size-3.5" aria-hidden />
            {tx.eachWindow}
          </Button>
        )}
      </div>

      {control && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
          <span className="text-muted" title={tx.keyModeHint}>
            {tx.keyboard}
          </span>
          <Select value={rd.keyMode} onChange={(e) => rd.setKeyMode(e.target.value as 'position' | 'character')} aria-label={tx.keyboard} title={tx.keyModeHint}>
            {(['position', 'character'] as const).map((m) => (
              <option key={m} value={m}>
                {tx.keyModes[m]}
              </option>
            ))}
          </Select>
          <Select
            value=""
            onChange={(e) => {
              if (e.target.value) t.sendCombo(e.target.value);
              e.target.value = '';
            }}
            aria-label={tx.specialKeys}
            disabled={!rd.mayControl}
          >
            <option value="">{tx.specialKeys}</option>
            {Object.keys(tx.combos).map((k) => (
              <option key={k} value={k}>
                {tx.combos[k]}
              </option>
            ))}
          </Select>
          {t.has('sas') && (
            <Button size="sm" onClick={t.sendSas} title={tx.sasHint} disabled={!rd.wsLive}>
              <Command className="size-3.5" aria-hidden />
              <span dir="ltr">{tx.sas}</span>
            </Button>
          )}
        </div>
      )}

      {canControl && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
          {t.may('block_input') && t.has('block_input') && t.holder && (
            <Button size="sm" onClick={t.toggleBlock} title={tx.blockHint} disabled={!rd.wsLive} className={clsx(t.inputBlocked && 'border-warn text-warn')}>
              <Ban className="size-3.5" aria-hidden />
              {t.inputBlocked ? tx.unblockInput : tx.blockInput}
            </Button>
          )}
          {t.may('privacy_screen') && t.has('privacy_screen') && t.holder && (
            <Button size="sm" onClick={t.togglePrivacy} title={tx.privacyHint} disabled={!rd.wsLive} className={clsx(t.privacy && 'border-warn text-warn')}>
              <EyeOff className="size-3.5" aria-hidden />
              {t.privacy ? tx.privacyOn : tx.privacy}
            </Button>
          )}
          {t.may('audio') && t.has('audio') && (
            <Button size="sm" onClick={() => void t.toggleAudio()} title={tx.audioHint} disabled={!rd.wsLive} className={clsx(t.audioOn && 'border-accent text-fg')}>
              {t.audioOn ? <Volume2 className="size-3.5" aria-hidden /> : <VolumeX className="size-3.5" aria-hidden />}
              {t.audioOn ? tx.audioOn : tx.audio}
            </Button>
          )}
          {t.may('record') && t.holder && (
            <Button size="sm" onClick={() => void t.toggleRecording()} busy={t.busy === 'rec'} title={tx.recordingHint} className={clsx(t.recording && 'border-crit text-crit')}>
              <CircleDot className="size-3.5" aria-hidden />
              {t.recording ? tx.stopRecording : tx.record}
            </Button>
          )}
          {t.may('control') && t.has('annotate') && (
            <>
              <Button size="sm" onClick={() => t.setAnnotate(t.annotate === 'draw' ? 'off' : 'draw')} title={tx.annotateHint} aria-pressed={t.annotate === 'draw'} className={clsx(t.annotate === 'draw' && 'border-accent text-fg')}>
                <Pencil className="size-3.5" aria-hidden />
                {tx.annotate}
              </Button>
              <Button size="sm" onClick={() => t.setAnnotate(t.annotate === 'laser' ? 'off' : 'laser')} aria-pressed={t.annotate === 'laser'} className={clsx(t.annotate === 'laser' && 'border-accent text-fg')}>
                <Crosshair className="size-3.5" aria-hidden />
                {tx.laser}
              </Button>
              <Button size="sm" onClick={t.clearDrawing} aria-label={tx.clearDrawing} title={tx.clearDrawing}>
                <Eraser className="size-3.5" aria-hidden />
              </Button>
            </>
          )}
        </div>
      )}

      {/* What the person sees: never hidden from the operator either. */}
      <div className="flex flex-wrap items-center gap-2">
        {t.recording && <Badge tone="crit">{tx.recordingOn}</Badge>}
        {t.privacy && t.privacyInfo && <span className="text-muted">{t.privacyInfo.excluded ? tx.privacyExcluded(t.privacyInfo.monitors) : tx.privacyNotExcluded}</span>}
        {t.audioOn && t.audioStats && <span className="mono text-muted">{tx.audioRate(t.audioStats.kbps, t.audioStats.rate, t.audioStats.ch)}</span>}
        {t.note && <span className={t.note.tone === 'ok' ? 'text-ok' : 'text-crit'}>{t.note.text}</span>}
      </div>
    </div>
  );
}

/**
 * The drawing layer over the live picture: strokes and the laser pointer go to the agent in
 * coordinates relative to the shown display (0…1), the agent draws them on a click-through layer.
 */
export function AnnotationLayer({ rd, t }: { rd: Rd; t: Tools }) {
  const [stroke, setStroke] = useState<Array<[number, number]>>([]);
  const [local, setLocal] = useState<Array<Array<[number, number]>>>([]);
  const drawing = useRef<Array<[number, number]> | null>(null);
  const lastPointer = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  if (t.annotate === 'off') return null;

  // Unit coordinates on the picture (null outside it), and pixel coordinates on this layer.
  const at = (e: React.PointerEvent): { u: [number, number]; p: [number, number] } | null => {
    const media = rd.rtc.active && rd.videoRef.current ? rd.videoRef.current : rd.canvasRef.current;
    const c = media ? mediaPictureBox(media) : null;
    const b = box.current?.getBoundingClientRect();
    if (!c || !b || c.width === 0) return null;
    const x = (e.clientX - c.left) / c.width;
    const y = (e.clientY - c.top) / c.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { u: [Number(x.toFixed(4)), Number(y.toFixed(4))], p: [e.clientX - b.left, e.clientY - b.top] };
  };
  const flush = () => {
    const pts = drawing.current;
    drawing.current = null;
    if (pts && pts.length >= 2) t.annotateOp({ op: 'stroke', points: pts.slice(0, 2000), color: '#ff3b30', width: 4 });
    setLocal((l) => (stroke.length >= 2 ? [...l.slice(-50), stroke] : l));
    setStroke([]);
  };

  return (
    <div
      ref={box}
      className={clsx('absolute inset-0 z-10', t.annotate === 'laser' ? 'cursor-none' : 'cursor-crosshair')}
      onPointerDown={(e) => {
        if (t.annotate !== 'draw') return;
        const a = at(e);
        if (!a) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drawing.current = [a.u];
        setStroke([a.p]);
      }}
      onPointerMove={(e) => {
        const a = at(e);
        if (t.annotate === 'laser') {
          const now = performance.now();
          if (now - lastPointer.current < 33) return;
          lastPointer.current = now;
          if (a) t.annotateOp({ op: 'pointer', x: a.u[0], y: a.u[1], color: '#ff3b30' });
          else rd.sendWs({ t: 'annotate', op: { op: 'pointer_hide' } });
          return;
        }
        if (!drawing.current || !a) return;
        drawing.current.push(a.u);
        setStroke((s) => [...s, a.p]);
        if (drawing.current.length >= 2000) flush();
      }}
      onPointerUp={flush}
      onPointerLeave={() => {
        if (t.annotate === 'laser') rd.sendWs({ t: 'annotate', op: { op: 'pointer_hide' } });
      }}
      onDoubleClick={() => {
        setLocal([]);
        t.clearDrawing();
      }}
    >
      <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
        {[...local, stroke].map((s, i) =>
          s.length > 1 ? <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} fill="none" stroke="#ff3b30" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" opacity={0.8} /> : null,
        )}
      </svg>
    </div>
  );
}

/** Chat with the person at the computer, and questions they answer in a box on their screen. */
export function ChatCard({ t, canControl }: { t: Tools; canControl: boolean }) {
  const { tx } = t;
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<AskItem['kind']>('yes_no');
  return (
    <Card title={tx.chat}>
      <div className="space-y-3">
        <ul className="max-h-60 space-y-1.5 overflow-y-auto rounded-md border border-line bg-bg/60 p-2 text-sm" aria-live="polite">
          {t.chat.length === 0 && <li className="text-xs text-muted">{tx.chatEmpty}</li>}
          {t.chat.map((m, i) => (
            <li key={i} className={clsx('flex flex-col', m.mine ? 'items-end' : 'items-start')}>
              <span className="text-[11px] text-muted" dir="auto">
                {m.from} · {ltr(new Date(m.at).toLocaleTimeString())}
              </span>
              <span className={clsx('max-w-[85%] whitespace-pre-wrap rounded-md px-2.5 py-1.5', m.mine ? 'bg-accent/15' : 'bg-raised')} dir="auto">
                {m.text}
              </span>
            </li>
          ))}
        </ul>
        {canControl && (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              t.sendChat(msg);
              setMsg('');
            }}
          >
            <Input value={msg} maxLength={2000} onChange={(e) => setMsg(e.target.value)} placeholder={tx.chatPlaceholder} dir="auto" aria-label={tx.chat} />
            <Button type="submit" size="sm" disabled={!msg.trim()}>
              <Send className="size-3.5 rtl:-scale-x-100" aria-hidden />
              {tx.send}
            </Button>
          </form>
        )}

        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-xs font-medium">{tx.ask}</p>
          {canControl && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                t.ask(q, kind);
                setQ('');
              }}
            >
              <Input className="min-w-60 flex-1" value={q} maxLength={500} onChange={(e) => setQ(e.target.value)} placeholder={tx.askPlaceholder} dir="auto" aria-label={tx.ask} />
              <Select value={kind} onChange={(e) => setKind(e.target.value as AskItem['kind'])} aria-label={tx.ask}>
                {(['yes_no', 'ok', 'text'] as const).map((k) => (
                  <option key={k} value={k}>
                    {tx.askKinds[k]}
                  </option>
                ))}
              </Select>
              <Button type="submit" size="sm" disabled={!q.trim()}>
                <MessageSquare className="size-3.5" aria-hidden />
                {tx.ask}
              </Button>
            </form>
          )}
          <ul className="space-y-1 text-sm">
            {t.asks.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line px-2.5 py-1.5">
                <span dir="auto">{a.text}</span>
                {a.answer ? (
                  <Badge tone={a.answer === 'yes' || a.answer === 'ok' || a.answer === 'text' ? 'ok' : a.answer === 'no' ? 'crit' : 'warn'}>
                    {tx.answers[a.answer] ?? a.answer}
                    {a.answerText ? `: ${a.answerText}` : ''}
                  </Badge>
                ) : (
                  <span className="text-xs text-muted">{tx.waitingAnswer}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/** Operators in the session: the holder invites colleagues, hands over, removes; colleagues join or leave. */
export function OperatorsCard({ t, meId, canControl }: { t: Tools; meId: string | null; canControl: boolean }) {
  const { tx } = t;
  const [who, setWho] = useState('');
  const [viewOnly, setViewOnly] = useState(false);
  const [code, setCode] = useState('');
  const holderRow = t.participants.find((p) => p.role === 'holder' && p.state === 'joined');
  const iHold = holderRow?.user_id === meId;
  const busyIds = new Set(t.participants.filter((p) => p.state === 'invited' || p.state === 'joined').map((p) => p.user_id));
  const invitable = t.team.filter((m) => m.status === 'active' && m.role !== 'viewer' && !busyIds.has(m.id));
  const meJoined = t.participants.some((p) => p.user_id === meId && p.state === 'joined' && p.role === 'colleague');
  const needsCode = t.error?.code === 'policy_mfa_required' || t.error?.code === 'policy_mfa_invalid';
  return (
    <Card title={tx.operators}>
      <div className="space-y-3 text-sm">
        {t.error && <ErrorNote error={t.error} />}
        {t.myInvite && canControl && (
          <Notice>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{tx.invitedNote(t.myInvite.invited_by_email ?? '')}</span>
              <span className="flex items-center gap-2">
                {needsCode && (
                  <Input
                    value={code}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    dir="ltr"
                    className="mono w-28 tracking-[0.3em]"
                    aria-label="MFA"
                  />
                )}
                <Button size="sm" variant="primary" busy={t.busy === 'join'} disabled={needsCode && code.length !== 6} onClick={() => void t.join(needsCode ? code : undefined)}>
                  <LogIn className="size-3.5 rtl:-scale-x-100" aria-hidden />
                  {tx.join}
                </Button>
                <Button size="sm" busy={t.busy === 'decline'} onClick={() => void t.decline()}>
                  <X className="size-3.5" aria-hidden />
                  {tx.decline}
                </Button>
              </span>
            </div>
          </Notice>
        )}
        <ul className="space-y-1">
          {t.participants.map((p) => (
            <li key={p.user_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-2.5 py-1.5">
              <span className="flex flex-wrap items-center gap-2">
                <Users className="size-3.5 text-muted" aria-hidden />
                {ltr(p.email)}
                <Badge tone={p.role === 'holder' ? 'info' : 'idle'}>{p.role === 'holder' ? tx.holder : tx.colleague}</Badge>
                <Badge tone={p.state === 'joined' ? 'ok' : p.state === 'invited' ? 'warn' : 'idle'}>{tx.participantState[p.state]}</Badge>
                {p.role === 'colleague' && !p.permissions.control && <Badge tone="idle">{tx.inviteViewOnly}</Badge>}
              </span>
              {canControl && iHold && p.role === 'colleague' && (p.state === 'joined' || p.state === 'invited') && (
                <span className="flex gap-1.5">
                  {p.state === 'joined' && (
                    <Button size="sm" busy={t.busy === 'handover'} onClick={() => void t.handOver(p.user_id)}>
                      {tx.handOver}
                    </Button>
                  )}
                  <Button size="sm" variant="danger" busy={t.busy === 'remove'} onClick={() => void t.remove(p.user_id)}>
                    {tx.remove}
                  </Button>
                </span>
              )}
              {canControl && p.user_id === meId && meJoined && (
                <Button size="sm" busy={t.busy === 'leave'} onClick={() => void t.leave()}>
                  <LogOut className="size-3.5 rtl:-scale-x-100" aria-hidden />
                  {tx.leave}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {canControl && iHold && invitable.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Select value={who} onChange={(e) => setWho(e.target.value)} aria-label={tx.inviteWho}>
              <option value="">{tx.inviteWho}</option>
              {invitable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name ? `${m.display_name} (${m.email})` : m.email}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} />
              {tx.inviteViewOnly}
            </label>
            <Button
              size="sm"
              disabled={!who}
              busy={t.busy === 'invite'}
              onClick={() => {
                void t.invite(who, viewOnly);
                setWho('');
              }}
            >
              <UserPlus className="size-3.5" aria-hidden />
              {tx.invite}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Pictures and copied files on the clipboard, drag-and-drop transfer and remote printing. */
export function TransferCard({ t, perms }: { t: Tools; perms: FleetPermissions | null }) {
  const { tx } = t;
  const [over, setOver] = useState(false);
  const [toClipboard, setToClipboard] = useState(false);
  const [printPath, setPrintPath] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const files = Boolean(perms?.files);
  const clipIn = Boolean(perms?.clipboard_in);
  const clipOut = Boolean(perms?.clipboard_out);
  return (
    <Card title={tx.transfer}>
      <div className="space-y-4 text-sm">
        {files && (
          <section className="space-y-2">
            <p className="text-xs text-muted">{tx.transferHint}</p>
            <label className="block text-xs" htmlFor="rd-transfer-destination">
              <span className="text-muted">{tx.destination}</span>
            </label>
            <Input id="rd-transfer-destination" value={t.destination} onChange={(e) => t.setDestination(e.target.value)} dir="ltr" className="mono" />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void t.uploadFiles(Array.from(e.dataTransfer.files), toClipboard && clipIn);
              }}
              className={clsx('flex min-h-20 w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed p-3 text-center text-xs', over ? 'border-accent bg-accent/10' : 'border-line-strong')}
            >
              <Upload className="size-5 text-muted" aria-hidden />
              {t.transferBusy ? ltr(t.transferBusy) : tx.transfer}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void t.uploadFiles(Array.from(e.target.files ?? []), toClipboard && clipIn);
                e.target.value = '';
              }}
            />
            {clipIn && (
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={toClipboard} onChange={(e) => setToClipboard(e.target.checked)} />
                {tx.putOnClipboard}
              </label>
            )}
          </section>
        )}

        {(clipIn || clipOut) && (
          <section className="space-y-2 border-t border-line pt-3">
            <p className="text-xs font-medium">{tx.clipboardImage}</p>
            <p className="text-xs text-muted">{tx.imageHint}</p>
            <div className="flex flex-wrap gap-2">
              {clipIn && (
                <>
                  <Button size="sm" onClick={() => void t.sendImage()}>
                    <Image className="size-3.5" aria-hidden />
                    {tx.sendImage}
                  </Button>
                  <Button size="sm" onClick={() => imageInput.current?.click()}>
                    <Upload className="size-3.5" aria-hidden />
                    PNG / JPEG
                  </Button>
                  <input
                    ref={imageInput}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void t.sendImage(f);
                      e.target.value = '';
                    }}
                  />
                </>
              )}
              {clipOut && (
                <Button size="sm" onClick={t.getImage}>
                  <Download className="size-3.5" aria-hidden />
                  {tx.getImage}
                </Button>
              )}
            </div>
            {t.remoteImage && (
              // biome-ignore lint/performance/noImgElement: a data: URL from the session, not a static asset.
              <img src={t.remoteImage} alt={tx.clipboardImage} className="max-h-48 rounded border border-line" />
            )}
          </section>
        )}

        {clipOut && files && (
          <section className="space-y-2 border-t border-line pt-3">
            <p className="text-xs font-medium">{tx.clipboardFiles}</p>
            <p className="text-xs text-muted">{tx.filesHint}</p>
            <Button size="sm" onClick={t.getFiles}>
              <Files className="size-3.5" aria-hidden />
              {tx.getFiles}
            </Button>
            {t.remoteFiles && (
              <ul className="space-y-1">
                {t.remoteFiles.map((p) => (
                  <li key={p} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1 text-xs">
                    <span className="mono truncate">{ltr(p)}</span>
                    <Button size="sm" onClick={() => void t.downloadToBrowser(p)}>
                      <Download className="size-3.5" aria-hidden />
                      {tx.download}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {files && (
          <section className="space-y-2 border-t border-line pt-3">
            <p className="text-xs font-medium">{tx.print}</p>
            <p className="text-xs text-muted">{tx.printHint}</p>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (printPath.trim()) void t.printRemote(printPath.trim());
              }}
            >
              <Input className="mono min-w-60 flex-1" value={printPath} onChange={(e) => setPrintPath(e.target.value)} placeholder={tx.printPath} aria-label={tx.printPath} dir="ltr" />
              <Button type="submit" size="sm" disabled={!printPath.trim() || Boolean(t.transferBusy)}>
                <Printer className="size-3.5" aria-hidden />
                {tx.print}
              </Button>
            </form>
          </section>
        )}
        {t.error && <ErrorNote error={t.error} />}
        {t.note && <p className={clsx('text-xs', t.note.tone === 'ok' ? 'text-ok' : 'text-crit')}>{t.note.text}</p>}
      </div>
    </Card>
  );
}

/** Offline computer: Wake-on-LAN through the site's Sensor, then the normal session request. */
export function WakeCard({ t, onWake, canControl }: { t: Tools; onWake: () => void; canControl: boolean }) {
  const { tx } = t;
  const w = t.wake;
  const left = w ? Math.max(0, Math.round((new Date(w.timeout_at).getTime() - Date.now()) / 1000)) : 0;
  const active = w && (w.state === 'waking' || w.state === 'online');
  return (
    <Card title={tx.wake}>
      <div className="space-y-2 text-sm">
        <p className="text-xs text-muted">{tx.wakeHint}</p>
        {w && (
          <Notice className={w.state === 'timed_out' || w.state === 'failed' ? 'border-warn/30 bg-warn/[0.08]' : undefined}>
            <span className="flex flex-wrap items-center gap-2">
              {w.state === 'connected' ? <Check className="size-3.5 text-ok" aria-hidden /> : <Power className="size-3.5" aria-hidden />}
              {w.state === 'waking' ? tx.wakeStates.waking(left) : (tx.wakeStates[w.state] as string)}
              {w.error ? ` ${w.error}` : ''}
            </span>
            {w.mac && <span className="mono mt-1 block text-xs text-muted">{tx.wakeVia(w)}</span>}
          </Notice>
        )}
        {canControl && (
          <div className="flex gap-2">
            {active ? (
              <Button size="sm" busy={t.busy === 'wake'} onClick={() => void t.cancelWake()}>
                {tx.cancel}
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={onWake}>
                <Power className="size-3.5" aria-hidden />
                {tx.wake}
              </Button>
            )}
          </div>
        )}
        {t.error && <ErrorNote error={t.error} />}
      </div>
    </Card>
  );
}
