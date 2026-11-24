import { useCallback, useEffect, useRef, useState } from 'react';
import type { EndpointCommand, EndpointDetail, FleetPermissions, FleetSessionParticipant, FleetWakeRequest, RemoteFileResponse, TeamOverview } from '@nigafiy/shared-types';
import { ApiError, api } from '@/lib/api';
import type { ConnectChoice } from '../fleet-policy/connect-dialog';
import { arrayBufferToBase64, base64ToUint8Array, formatBytes } from '../remote-files/file-utils';
import { decodeAdpcm, parseAudioPacket } from './adpcm';
import { toolsText } from './tools-text';
import type { useRemoteDesktop } from './use-remote-desktop';

type Rd = ReturnType<typeof useRemoteDesktop>;

export interface ChatLine {
  from: string;
  text: string;
  at: number;
  mine: boolean;
}
export interface AskItem {
  id: string;
  text: string;
  kind: 'ok' | 'yes_no' | 'text';
  answer?: string;
  answerText?: string;
}
export type QualityMode = 'best' | 'balanced' | 'fast';
export type AnnotateMode = 'off' | 'draw' | 'laser';

/** Physical keys (KeyboardEvent.code) of the shortcuts the operator's own OS would catch. */
export const COMBOS: Record<string, string[]> = {
  alt_tab: ['AltLeft', 'Tab'],
  ctrl_esc: ['ControlLeft', 'Escape'],
  win_r: ['MetaLeft', 'KeyR'],
  win_l: ['MetaLeft', 'KeyL'],
  win_e: ['MetaLeft', 'KeyE'],
  ctrl_shift_esc: ['ControlLeft', 'ShiftLeft', 'Escape'],
  alt_f4: ['AltLeft', 'F4'],
};

const QUALITY: Record<QualityMode, { quality: number; scale: number; adaptive: boolean }> = {
  best: { quality: 85, scale: 1, adaptive: false },
  balanced: { quality: 68, scale: 0.75, adaptive: true },
  fast: { quality: 45, scale: 0.5, adaptive: true },
};

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const PRINTABLE: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/plain',
};

/**
 * The in-session tools of the viewer: everything goes over the session's socket (checked by the
 * hub and again by the agent) or through the REST routes of session-tools.ts. Nothing here can
 * hide the banner, the recording mark or the privacy-screen text on the computer.
 */
export function useSessionTools(rd: Rd, epId: string, meId: string | null) {
  const tx = toolsText(rd.locale);
  const [myPerms, setMyPerms] = useState<FleetPermissions | null>(null);
  const [holder, setHolder] = useState(true);
  const [operators, setOperators] = useState<string[]>([]);
  const [recording, setRecording] = useState(Boolean(rd.session?.recording_id));
  const [privacy, setPrivacy] = useState(false);
  const [privacyInfo, setPrivacyInfo] = useState<{ monitors: number; excluded: boolean } | null>(null);
  const [inputBlocked, setInputBlocked] = useState(false);
  const [audioOn, setAudioOn] = useState(false);
  const [audioStats, setAudioStats] = useState<{ kbps: number; rate: number; ch: number } | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [asks, setAsks] = useState<AskItem[]>([]);
  const [note, setNote] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);
  const [remoteImage, setRemoteImage] = useState<string | null>(null);
  const [remoteFiles, setRemoteFiles] = useState<string[] | null>(null);
  const [annotate, setAnnotate] = useState<AnnotateMode>('off');
  const [depth, setDepthState] = useState<24 | 16 | 8>(24);
  const [cursor, setCursorState] = useState(true);
  const [participants, setParticipants] = useState<FleetSessionParticipant[]>([]);
  const [team, setTeam] = useState<TeamOverview['members']>([]);
  const [destination, setDestination] = useState('');
  const [transferBusy, setTransferBusy] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [wake, setWake] = useState<FleetWakeRequest | null>(null);
  const seq = useRef(0);
  const audioCtx = useRef<AudioContext | null>(null);
  const audioAt = useRef(0);
  const audioBytes = useRef({ n: 0, since: 0 });
  const features: string[] = ((rd.hello as unknown as { features?: string[] } | null)?.features ?? []) as string[];
  const has = (f: string) => features.includes(f);
  const perms = myPerms ?? rd.permissions;
  const may = (k: keyof FleetPermissions) => Boolean(perms?.[k]);
  const sessionId = rd.session?.id ?? null;

  const playAudio = useCallback((buf: ArrayBuffer) => {
    const pkt = parseAudioPacket(buf);
    const ctx = audioCtx.current;
    if (!pkt || !ctx) return;
    const chans = decodeAdpcm(pkt.header, pkt.data);
    const ab = ctx.createBuffer(pkt.header.ch, pkt.header.frames, pkt.header.rate);
    for (let i = 0; i < chans.length; i++) ab.copyToChannel(chans[i] as Float32Array<ArrayBuffer>, i);
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(ctx.destination);
    // A small jitter buffer: start 120 ms ahead, never schedule in the past.
    const at = Math.max(ctx.currentTime + 0.12, audioAt.current);
    src.start(at);
    audioAt.current = at + ab.duration;
    const now = performance.now();
    const m = audioBytes.current;
    if (!m.since) m.since = now;
    m.n += buf.byteLength;
    if (now - m.since >= 2000) {
      setAudioStats({ kbps: Math.round((m.n * 8) / (now - m.since)), rate: pkt.header.rate, ch: pkt.header.ch });
      m.n = 0;
      m.since = now;
    }
  }, []);

  // Socket messages of the tools.
  useEffect(() => {
    const listeners = rd.toolListeners.current;
    const on = (m: Record<string, unknown> | ArrayBuffer) => {
      if (m instanceof ArrayBuffer) {
        playAudio(m);
        return;
      }
      switch (m.t) {
        case 'session':
        case 'operators':
          if (m.permissions) setMyPerms(m.permissions as FleetPermissions);
          if (typeof m.holder === 'boolean') setHolder(m.holder);
          if (Array.isArray(m.operators)) setOperators(m.operators as string[]);
          if (typeof m.recording === 'boolean') setRecording(m.recording);
          break;
        case 'recording':
          setRecording(m.on === true);
          break;
        case 'tool_state':
          setPrivacy(m.privacy === true);
          setInputBlocked(m.input_blocked === true);
          if (typeof m.recording === 'boolean') setRecording(m.recording);
          if (Array.isArray(m.operators) && m.operators.length) setOperators(m.operators as string[]);
          if (typeof m.privacy_monitors === 'number') setPrivacyInfo({ monitors: m.privacy_monitors, excluded: m.privacy_excluded === true });
          break;
        case 'tool_error':
          setNote({ tone: 'crit', text: String(m.code ?? '').startsWith('profile_forbids') ? tx.forbidden(String(m.tool)) : m.code === 'unsupported_here' ? `${tx.unsupported} ${String(m.error ?? '')}` : String(m.error ?? '') });
          if (m.tool === 'audio') setAudioOn(false);
          break;
        case 'sas_result':
          setNote(m.ok ? { tone: 'ok', text: tx.sasSent } : { tone: 'crit', text: String(m.error ?? '') });
          break;
        case 'chat':
          setChat((c) => [...c.slice(-199), { from: m.from === 'user' ? tx.user : String(m.from ?? ''), text: String(m.text ?? ''), at: Date.now(), mine: false }]);
          break;
        case 'answer':
          setAsks((a) => a.map((q) => (q.id === m.id ? { ...q, answer: String(m.answer), answerText: typeof m.text === 'string' ? m.text : undefined } : q)));
          break;
        case 'clipboard':
          if (m.format === 'image' && typeof m.data === 'string') setRemoteImage(`data:image/png;base64,${m.data}`);
          if (m.format === 'files' && Array.isArray(m.paths)) setRemoteFiles(m.paths as string[]);
          break;
        case 'clipboard_error':
          if (m.format === 'image' || m.format === 'files') setNote({ tone: 'crit', text: String(m.error ?? '') });
          break;
        case 'clipboard_set_ok':
          if (m.format === 'image' || m.format === 'files') setNote({ tone: 'ok', text: '✓' });
          break;
      }
    };
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, [rd.toolListeners, playAudio, tx]);

  // A new session starts with every tool off.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger.
  useEffect(() => {
    setPrivacy(false);
    setInputBlocked(false);
    setAudioOn(false);
    setChat([]);
    setAsks([]);
    setRemoteImage(null);
    setRemoteFiles(null);
    setAnnotate('off');
    setRecording(Boolean(rd.session?.recording_id));
    void audioCtx.current?.close();
    audioCtx.current = null;
  }, [sessionId]);

  const send = (m: Record<string, unknown>) => {
    if (!rd.sendWs(m)) setNote({ tone: 'crit', text: rd.isAr ? 'يتطلب البث الحي' : 'Needs the live stream' });
  };

  // ── Picture ──
  function setQualityMode(mode: QualityMode) {
    const q = QUALITY[mode];
    rd.setQuality(q.quality);
    rd.setScale(q.scale);
    rd.setAdaptive(q.adaptive);
  }
  const qualityMode: QualityMode | null = (Object.keys(QUALITY) as QualityMode[]).find((k) => QUALITY[k].quality === rd.quality && QUALITY[k].scale === rd.scale) ?? null;
  function setDepth(d: 24 | 16 | 8) {
    setDepthState(d);
    send({ t: 'settings', depth: d });
  }
  function setCursor(on: boolean) {
    setCursorState(on);
    send({ t: 'settings', cursor: on });
  }

  /** Each monitor in its own window: all displays in the stream, cut per monitor in each window. */
  function openMonitorWindows() {
    const all = rd.displays.find((d) => d.all);
    const monitors = rd.displays.filter((d) => !d.all);
    if (!all || monitors.length < 2) return;
    rd.setDisplayIndex(all.index);
    const minX = Math.min(...monitors.map((d) => d.x));
    const minY = Math.min(...monitors.map((d) => d.y));
    for (const d of monitors) {
      const w = window.open('', `nigafiy-monitor-${epId}-${d.index}`, `popup,width=${Math.round(d.width / 2)},height=${Math.round(d.height / 2)}`);
      if (!w) {
        setNote({ tone: 'crit', text: tx.popupBlocked });
        return;
      }
      w.document.title = `${d.name} · Nigafiy`;
      w.document.body.style.cssText = 'margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh';
      const c = w.document.createElement('canvas');
      c.style.cssText = 'max-width:100%;max-height:100%';
      w.document.body.replaceChildren(c);
      const draw = () => {
        if (w.closed) return;
        const src = rd.canvasRef.current;
        if (src && src.width > 0) {
          // The all-displays picture is the virtual screen scaled into the canvas.
          const fx = src.width / all.width;
          const fy = src.height / all.height;
          const sx = (d.x - minX) * fx;
          const sy = (d.y - minY) * fy;
          const sw = d.width * fx;
          const sh = d.height * fy;
          if (c.width !== Math.round(sw)) c.width = Math.round(sw);
          if (c.height !== Math.round(sh)) c.height = Math.round(sh);
          c.getContext('2d')?.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
        }
        w.requestAnimationFrame(draw);
      };
      w.requestAnimationFrame(draw);
    }
  }

  // ── Input ──
  function sendCombo(name: string) {
    if (name === 'win') return void rd.sendInput({ kind: 'key_press', key: 'Meta' });
    if (name === 'print') return void rd.sendInput({ kind: 'key_press', key: 'PrintScreen' });
    const keys = COMBOS[name];
    if (keys) void rd.sendInput({ kind: 'key_combo', keys });
  }
  const sendSas = () => send({ t: 'sas' });
  const togglePrivacy = () => send({ t: 'privacy', on: !privacy });
  const toggleBlock = () => send({ t: 'block_input', on: !inputBlocked });

  // ── Sound ──
  async function toggleAudio() {
    if (audioOn) {
      send({ t: 'audio', on: false });
      setAudioOn(false);
      void audioCtx.current?.close();
      audioCtx.current = null;
      setAudioStats(null);
      return;
    }
    // Created on the click: browsers only play sound started by a user gesture.
    audioCtx.current = new AudioContext();
    audioAt.current = 0;
    audioBytes.current = { n: 0, since: 0 };
    send({ t: 'audio', on: true });
    setAudioOn(true);
  }

  // ── Chat and questions ──
  function sendChat(text: string) {
    const t = text.trim();
    if (!t) return;
    seq.current += 1;
    send({ t: 'chat', id: `m${seq.current}`, text: t });
    setChat((c) => [...c.slice(-199), { from: tx.you, text: t, at: Date.now(), mine: true }]);
  }
  function ask(text: string, kind: AskItem['kind']) {
    const t = text.trim();
    if (!t) return;
    seq.current += 1;
    const id = `q${seq.current}`;
    send({ t: 'ask', id, text: t, kind, timeout_s: 300 });
    setAsks((a) => [...a, { id, text: t, kind }]);
  }

  // ── Annotations ──
  function annotateOp(op: Record<string, unknown>) {
    const disp = rd.displays.find((d) => d.index === rd.displayIndex) ?? { x: 0, y: 0, width: 1920, height: 1080 };
    send({ t: 'annotate', op: { ...op, display: { x: disp.x, y: disp.y, w: Math.max(1, disp.width), h: Math.max(1, disp.height) } } });
  }
  const clearDrawing = () => send({ t: 'annotate', op: { op: 'clear' } });

  // ── Clipboard pictures and files ──
  async function sendImage(file?: File) {
    let blob: Blob | null = file ?? null;
    if (!blob) {
      try {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t === 'image/png');
          if (type) blob = await item.getType(type);
        }
      } catch {
        blob = null;
      }
    }
    if (!blob) return setNote({ tone: 'crit', text: tx.noImage });
    if (blob.type !== 'image/png') blob = await toPng(blob);
    if (blob.size > 4 << 20) return setNote({ tone: 'crit', text: tx.imageHint });
    seq.current += 1;
    send({ t: 'clipboard_set', req: `i${seq.current}`, format: 'image', data: arrayBufferToBase64(await blob.arrayBuffer()) });
  }
  function getImage() {
    seq.current += 1;
    send({ t: 'clipboard_get', req: `i${seq.current}`, format: 'image' });
  }
  function getFiles() {
    seq.current += 1;
    send({ t: 'clipboard_get', req: `f${seq.current}`, format: 'files' });
  }

  // ── File transfer (the chunked, SHA-256 checked fs_op path), drag and drop, printing ──
  const runFsOp = useCallback(
    async (payload: Record<string, unknown>): Promise<RemoteFileResponse> => {
      const cmd = await api<EndpointCommand>(`/endpoints/${epId}/commands?wait_ms=4500`, { method: 'POST', body: { kind: 'fs_op', ...payload } });
      for (let i = 0; i < 20; i++) {
        const c = i === 0 ? cmd : (await api<EndpointDetail>(`/endpoints/${epId}`)).commands.find((x) => x.id === cmd.id);
        if (c?.status === 'completed' && c.result_data) return c.result_data as unknown as RemoteFileResponse;
        if (c?.status === 'failed') throw new ApiError(422, 'fs_op_failed', c.error ?? 'File operation failed on the computer');
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new ApiError(504, 'timeout', 'Timed out waiting for the agent');
    },
    [epId],
  );

  // The destination starts at the remote user's home folder (once per session).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger.
  useEffect(() => {
    if (!sessionId || destination || !may('files')) return;
    runFsOp({ op: 'roots' })
      .then((r) => setDestination(r.roots?.find((x) => x.name === 'Home')?.path ?? r.roots?.[0]?.path ?? ''))
      .catch(() => undefined);
  }, [sessionId]);

  async function uploadFiles(files: File[], toClipboard: boolean) {
    if (!may('files') || !destination) return;
    const sep = destination.includes('\\') ? '\\' : '/';
    const sent: string[] = [];
    setError(null);
    try {
      for (const file of files) {
        setTransferBusy(file.name);
        const buf = await file.arrayBuffer();
        const sha = await sha256Hex(buf);
        const remotePath = destination.endsWith(sep) ? `${destination}${file.name}` : `${destination}${sep}${file.name}`;
        const chunk = 256 * 1024;
        let offset = 0;
        do {
          const end = Math.min(buf.byteLength, offset + chunk);
          // Never overwrites: an existing file with that name is refused by the agent.
          await runFsOp({
            op: 'upload',
            path: remotePath,
            offset,
            append: offset > 0,
            data_base64: arrayBufferToBase64(buf.slice(offset, end)),
            ...(end >= buf.byteLength ? { expected_sha256: sha } : {}),
          });
          offset = end;
        } while (offset < buf.byteLength);
        await api(`/endpoints/${epId}/remote-desktop/transfer`, { method: 'POST', body: { direction: 'to_remote', via: 'drag_drop', name: file.name, bytes: buf.byteLength, sha256: sha } });
        sent.push(remotePath);
        setNote({ tone: 'ok', text: tx.sent(file.name, formatBytes(buf.byteLength)) });
      }
      if (toClipboard && sent.length) {
        seq.current += 1;
        send({ t: 'clipboard_set', req: `f${seq.current}`, format: 'files', paths: sent });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setTransferBusy(null);
    }
  }

  async function downloadRemote(path: string): Promise<{ blob: Blob; name: string; sha: string }> {
    const name = path.split(/[\\/]/).pop() ?? 'file';
    const parts: Uint8Array[] = [];
    let offset = 0;
    let sha = '';
    setTransferBusy(name);
    try {
      for (;;) {
        const r = await runFsOp({ op: 'download', path, offset, length: 256 * 1024 });
        if (r.data_base64) {
          const raw = base64ToUint8Array(r.data_base64);
          parts.push(raw);
          offset += raw.byteLength;
        }
        if (r.sha256) sha = r.sha256;
        if (r.eof || !r.bytes_read) break;
      }
    } finally {
      setTransferBusy(null);
    }
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return { blob: new Blob(parts as BlobPart[], { type: PRINTABLE[ext] ?? 'application/octet-stream' }), name, sha };
  }

  async function downloadToBrowser(path: string) {
    setError(null);
    try {
      const { blob, name, sha } = await downloadRemote(path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      if (sha) await api(`/endpoints/${epId}/remote-desktop/transfer`, { method: 'POST', body: { direction: 'from_remote', via: 'clipboard', name, bytes: blob.size, sha256: sha } });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    }
  }

  /** Remote printing: the file comes to this browser, whose print dialog prints it locally. */
  async function printRemote(path: string) {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (!PRINTABLE[ext]) return setNote({ tone: 'crit', text: tx.printNotSupported });
    setError(null);
    try {
      const { blob, name, sha } = await downloadRemote(path);
      const url = URL.createObjectURL(blob);
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;width:0;height:0;border:0;inset-inline-end:0;bottom:0';
      frame.src = url;
      frame.onload = () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(url);
        }, 60_000);
      };
      document.body.appendChild(frame);
      await api(`/endpoints/${epId}/remote-desktop/print`, { method: 'POST', body: { name, bytes: blob.size, sha256: sha || (await sha256Hex(await blob.arrayBuffer())), mime: blob.type } });
      setNote({ tone: 'ok', text: tx.printDone });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    }
  }

  // ── Recording and operators ──
  async function rest<T>(name: string, path: string, body: Record<string, unknown> = {}, method: 'POST' | 'GET' = 'POST'): Promise<T | null> {
    setBusy(name);
    setError(null);
    try {
      return await api<T>(path, method === 'GET' ? {} : { method, body });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
      return null;
    } finally {
      setBusy('');
    }
  }
  async function toggleRecording() {
    const r = await rest<{ recording_id: string | null }>('rec', `/endpoints/${epId}/remote-desktop/recording`, { on: !recording });
    if (r) setRecording(r.recording_id !== null);
  }
  const loadParticipants = useCallback(async () => {
    if (!sessionId) return setParticipants([]);
    try {
      setParticipants((await api<{ participants: FleetSessionParticipant[] }>(`/endpoints/${epId}/remote-desktop/participants`)).participants);
    } catch {
      /* shown on the next action */
    }
  }, [epId, sessionId]);
  useEffect(() => {
    void loadParticipants();
    if (!sessionId) return;
    const t = setInterval(() => void loadParticipants(), 10_000);
    return () => clearInterval(t);
  }, [loadParticipants, sessionId]);
  useEffect(() => {
    api<TeamOverview>('/team')
      .then((t) => setTeam(t.members))
      .catch(() => undefined);
  }, []);
  const invite = async (userId: string, viewOnly: boolean) => {
    const viewOnlyPerms = viewOnly ? Object.fromEntries(Object.keys(perms ?? {}).map((k) => [k, k === 'view'])) : undefined;
    if (await rest('invite', `/endpoints/${epId}/remote-desktop/participants`, { user_id: userId, ...(viewOnlyPerms ? { permissions: viewOnlyPerms } : {}) })) await loadParticipants();
  };
  /** Joining re-checks the access policy for this operator; a 6-digit code when it requires MFA. */
  const join = async (code?: string) => {
    let token: string | undefined;
    if (code) {
      const r = await rest<{ step_up_token: string }>('join', '/fleet/step-up', { code });
      if (!r) return;
      token = r.step_up_token;
    }
    if (await rest('join', `/endpoints/${epId}/remote-desktop/participants/join`, token ? { step_up_token: token } : {})) {
      await loadParticipants();
      rd.requestFull();
    }
  };
  const decline = async () => {
    if (await rest('decline', `/endpoints/${epId}/remote-desktop/participants/decline`)) await loadParticipants();
  };
  const handOver = async (userId: string) => {
    if (await rest('handover', `/endpoints/${epId}/remote-desktop/participants/${userId}/handover`)) await loadParticipants();
  };
  const leave = async () => {
    if (await rest('leave', `/endpoints/${epId}/remote-desktop/participants/leave`)) await loadParticipants();
  };
  const remove = async (userId: string) => {
    if (await rest('remove', `/endpoints/${epId}/remote-desktop/participants/${userId}/remove`)) await loadParticipants();
  };
  const myInvite = participants.find((p) => p.user_id === meId && p.state === 'invited') ?? null;

  // ── Wake-on-LAN then connect ──
  const pendingStart = useRef<ConnectChoice | null>(null);
  async function requestWake(choice: ConnectChoice): Promise<ApiError | null> {
    try {
      const r = await api<{ wake: FleetWakeRequest }>(`/endpoints/${epId}/remote-desktop/wake`, { method: 'POST', body: { reason: choice.reason, profile_id: choice.profile_id, timeout_s: 300 } });
      pendingStart.current = choice;
      setWake(r.wake);
      return null;
    } catch (err) {
      return err instanceof ApiError ? err : new ApiError(0, 'error', String(err));
    }
  }
  const wakeId = wake?.id;
  const wakeState = wake?.state;
  useEffect(() => {
    if (!wakeId || (wakeState !== 'waking' && wakeState !== 'online')) return;
    const t = setInterval(async () => {
      try {
        const r = await api<{ wake: FleetWakeRequest | null }>(`/endpoints/${epId}/remote-desktop/wake`);
        if (!r.wake || r.wake.id !== wakeId) return;
        setWake(r.wake);
        if (r.wake.state === 'online' && pendingStart.current) {
          // Online again: the normal session request (the whole access policy decides again).
          const choice = pendingStart.current;
          pendingStart.current = null;
          const refused = await rd.requestSession({ ...choice, wake_request_id: wakeId });
          if (refused) setError(refused);
        }
      } catch {
        /* next tick */
      }
    }, 3_000);
    return () => clearInterval(t);
  }, [epId, wakeId, wakeState, rd]);
  async function cancelWake() {
    if (!wake) return;
    pendingStart.current = null;
    if (await rest('wake', `/endpoints/${epId}/remote-desktop/wake/${wake.id}/cancel`)) setWake({ ...wake, state: 'cancelled' });
  }

  return {
    tx,
    perms,
    may,
    has,
    features,
    holder,
    operators,
    recording,
    privacy,
    privacyInfo,
    inputBlocked,
    audioOn,
    audioStats,
    chat,
    asks,
    note,
    setNote,
    remoteImage,
    remoteFiles,
    annotate,
    setAnnotate,
    depth,
    setDepth,
    cursor,
    setCursor,
    qualityMode,
    setQualityMode,
    openMonitorWindows,
    sendCombo,
    sendSas,
    togglePrivacy,
    toggleBlock,
    toggleAudio,
    sendChat,
    ask,
    annotateOp,
    clearDrawing,
    sendImage,
    getImage,
    getFiles,
    destination,
    setDestination,
    transferBusy,
    uploadFiles,
    downloadToBrowser,
    printRemote,
    toggleRecording,
    participants,
    team,
    invite,
    join,
    decline,
    handOver,
    leave,
    remove,
    myInvite,
    wake,
    requestWake,
    cancelWake,
    busy,
    error,
  };
}

async function toPng(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')?.drawImage(bmp, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG conversion failed'))), 'image/png'));
}
