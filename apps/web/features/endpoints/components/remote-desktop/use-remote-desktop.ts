import { useCallback, useEffect, useRef, useState } from 'react';
import type { EndpointCommand, EndpointDetail, FleetPermissions, FleetSession, FleetSessionStatus, RemoteDesktopDisplay, RemoteDesktopFrame } from '@nigafiy/shared-types';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { ConnectChoice } from '../fleet-policy/connect-dialog';
import { policyText } from '../fleet-policy/policy-text';
import { type StreamHello, type StreamStats, drawFrame, drawJpegBase64, parsePacket, streamUrl } from './rd-stream';

export interface RemoteDesktopConsoleProps {
  ep: EndpointDetail;
  online: boolean;
  /** May start and stop sessions. */
  canControl: boolean;
  /** The agent cannot inject mouse/keyboard input on this platform. */
  viewOnly?: boolean;
  onReload: () => void;
}

/** How the picture reaches this browser. */
export type RdPath = 'connecting' | 'direct' | 'relay' | 'waiting' | 'http';

const MAX_CLIPBOARD = 16_000;
/** Consoles open per endpoint in this tab (a session is ended when the last one closes). */
const openConsoles = new Map<string, number>();
/** With the socket open but no agent stream for this long, frames are fetched over HTTP meanwhile. */
const WAITING_FALLBACK_MS = 6_000;

/**
 * The live Remote Desktop session: status (consent, banner), the live WebSocket stream (binary
 * tile frames drawn on a canvas, acknowledged for the agent's adaptive quality), the HTTP fallback
 * (one rd_capture per frame), input and clipboard. The component only renders.
 */
export function useRemoteDesktop({ ep, online, canControl, viewOnly = false, onReload }: RemoteDesktopConsoleProps) {
  const { locale } = useI18n();
  const isAr = locale === 'ar';

  const [status, setStatus] = useState<FleetSessionStatus | null>(null);
  const [lastEnded, setLastEnded] = useState<FleetSession | null>(null);
  const session = status?.session ?? ep.rd_session ?? null;
  const sessionId = session?.id ?? null;
  const state = session ? (session.state ?? 'active') : null;
  const live = state === 'active';
  /** What the session's permission profile allows (null: not open, or a server before profiles). */
  const permissions: FleetPermissions | null = session?.permissions ?? status?.fleet_session?.permissions ?? null;
  const allows = (k: keyof FleetPermissions) => !permissions || permissions[k];
  const codeText = (m: Record<string, unknown>) => (typeof m.code === 'string' && policyText(locale).codes[m.code]) || String(m.error ?? '');

  const [interactive, setInteractive] = useState(true);
  const [displayIndex, setDisplayIndex] = useState<number>(ep.rd_session?.display_index ?? 0);
  const [quality, setQuality] = useState<number>(ep.rd_session?.quality ?? 68);
  const [scale, setScale] = useState<number>(ep.rd_session?.scale ?? 0.75);
  const [adaptive, setAdaptive] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);

  const [path, setPath] = useState<RdPath>('connecting');
  const [hello, setHello] = useState<StreamHello | null>(null);
  const [displays, setDisplays] = useState<RemoteDesktopDisplay[]>(ep.last_rd_frame?.displays ?? []);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [httpFrame, setHttpFrame] = useState<RemoteDesktopFrame | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [streamNote, setStreamNote] = useState<string | null>(null);

  const [textToType, setTextToType] = useState('');
  const [clipOut, setClipOut] = useState('');
  const [clipIn, setClipIn] = useState<string | null>(null);
  const [clipNote, setClipNote] = useState<{ tone: 'ok' | 'crit'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  /** The in-session tools (use-session-tools.ts) listen to every text message and to audio packets. */
  const toolListeners = useRef(new Set<(m: Record<string, unknown> | ArrayBuffer) => void>());
  /** Keys by physical position (the remote layout decides the character) or by character. */
  const [keyMode, setKeyMode] = useState<'position' | 'character'>('position');
  const drawChain = useRef<Promise<void>>(Promise.resolve());
  const inFlightRef = useRef(false);
  const waitingSince = useRef<number | null>(null);
  const lastMove = useRef(0);
  const reqSeq = useRef(0);
  const [wsAttempt, setWsAttempt] = useState(0);
  const [, setTick] = useState(0);

  // ── Session status (consent, banner, stream) ──
  const loadStatus = useCallback(async () => {
    try {
      const st = await api<FleetSessionStatus>(`/endpoints/${ep.id}/remote-desktop/session`);
      setStatus((prev) => {
        if (prev?.session && !st.session) {
          // It just ended: find out how (declined, no answer, ended from the banner…).
          void api<{ sessions: FleetSession[] }>(`/fleet/sessions?endpoint_id=${ep.id}&limit=1`)
            .then((r) => setLastEnded(r.sessions[0] ?? null))
            .catch(() => undefined);
        }
        return st;
      });
    } catch (err) {
      if (err instanceof ApiError && err.status !== 0) setError(err);
    }
  }, [ep.id]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Leaving the console ends the session: no banner stays on the user's screen with nobody
  // watching. (Counted per endpoint, so a remount — React's development double mount — keeps it.)
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;
  useEffect(() => {
    openConsoles.set(ep.id, (openConsoles.get(ep.id) ?? 0) + 1);
    return () => {
      const left = (openConsoles.get(ep.id) ?? 1) - 1;
      openConsoles.set(ep.id, left);
      const open = sessionRef.current;
      setTimeout(() => {
        if (open && (openConsoles.get(ep.id) ?? 0) === 0) void api(`/endpoints/${ep.id}/remote-desktop/stop`, { method: 'POST', body: {} }).catch(() => undefined);
      }, 1_000);
    };
  }, [ep.id]);

  // While a session is open: re-read it (consent answer, banner state, the agent's socket).
  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(() => void loadStatus(), state === 'waiting_consent' || state === 'waiting_approval' ? 1_500 : 4_000);
    return () => clearInterval(t);
  }, [sessionId, state, loadStatus]);

  // A once-a-second tick for the consent countdown and the "waiting" fallback.
  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [sessionId]);

  // ── Live stream (WebSocket) ──
  const sendWs = useCallback((m: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: wsAttempt is the reconnect trigger.
  useEffect(() => {
    if (!sessionId || !online) return;
    setPath('connecting');
    setStreamNote(null);
    let opened = false;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ws = new WebSocket(streamUrl(ep.id, sessionId));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        // 'N', 2: an audio packet for the tools; 'N', 1: a frame.
        if ((ev.data as ArrayBuffer).byteLength > 1 && new Uint8Array(ev.data as ArrayBuffer, 0, 2)[1] === 2) {
          for (const l of toolListeners.current) l(ev.data as ArrayBuffer);
          return;
        }
        const parsed = parsePacket(ev.data as ArrayBuffer);
        if (!parsed) return;
        const { header, tiles } = parsed;
        drawChain.current = drawChain.current
          .then(async () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            await drawFrame(canvas, header, tiles);
            setHasPicture(true);
            if (header.displays?.length) setDisplays(header.displays);
            // Drawn: the agent measures its round trip on this (adaptive quality).
            sendWs({ t: 'ack', seq: header.seq });
          })
          .catch(() => undefined);
        return;
      }
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (m.t) {
        case 'path':
          setPath(m.path === 'direct' || m.path === 'relay' ? m.path : 'waiting');
          waitingSince.current = m.path === 'waiting' ? Date.now() : null;
          break;
        case 'session':
          void loadStatus();
          break;
        case 'hello':
          setHello(m as unknown as StreamHello);
          if (Array.isArray(m.displays) && m.displays.length) setDisplays(m.displays as RemoteDesktopDisplay[]);
          break;
        case 'displays':
          if (Array.isArray(m.displays)) setDisplays(m.displays as RemoteDesktopDisplay[]);
          break;
        case 'stats':
          setStats(m as unknown as StreamStats);
          break;
        case 'clipboard':
          setClipIn(String(m.text ?? ''));
          setClipNote(null);
          break;
        case 'clipboard_set_ok':
          setClipNote({ tone: 'ok', text: 'sent' });
          break;
        case 'clipboard_error':
        case 'input_error':
        case 'error':
          if (m.t === 'clipboard_error') setClipNote({ tone: 'crit', text: codeText(m) });
          else setStreamNote(codeText(m));
          break;
        case 'end':
          void loadStatus();
          break;
      }
      for (const l of toolListeners.current) l(m);
    };
    ws.onclose = (ev) => {
      if (wsRef.current === ws) wsRef.current = null;
      if (disposed) return;
      if (ev.code === 4000) {
        // The session is over (ended here, by another operator or by the user at the computer).
        void loadStatus();
        onReload();
        return;
      }
      // Not available from here (or dropped): HTTP frames, and another try in a while.
      setPath(opened ? 'waiting' : 'http');
      waitingSince.current = Date.now() - WAITING_FALLBACK_MS;
      retry = setTimeout(() => setWsAttempt((n) => n + 1), opened ? 2_000 : 10_000);
    };
    return () => {
      disposed = true;
      clearTimeout(retry);
      ws.close(1000);
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [ep.id, sessionId, online, wsAttempt, sendWs, loadStatus, onReload, locale]);

  // Quality / scale / display choices go to the agent over the socket (again when the path changes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: path is the trigger (a new socket needs the settings).
  useEffect(() => {
    if (!live) return;
    sendWs({ t: 'settings', display: displayIndex, quality, scale, adaptive });
  }, [live, displayIndex, quality, scale, adaptive, sendWs, path]);

  const wsLive = path === 'direct' || path === 'relay';
  const useHttp = live && online && (path === 'http' || (path === 'waiting' && waitingSince.current !== null && Date.now() - waitingSince.current >= WAITING_FALLBACK_MS));

  // ── HTTP fallback: one rd_capture command per frame ──
  const captureNextFrame = useCallback(async () => {
    if (!online || inFlightRef.current) return;
    inFlightRef.current = true;
    const t0 = performance.now();
    try {
      const cmd = await api<EndpointCommand>(`/endpoints/${ep.id}/commands?wait_ms=3500`, {
        method: 'POST',
        body: { kind: 'rd_capture', display_index: displayIndex, quality, scale, ...(hasPicture ? {} : { full_frame: true }) },
      });
      setRttMs(Math.round(performance.now() - t0));
      if (cmd.status === 'failed') {
        setStreamNote(cmd.error ?? (isAr ? 'تعذّر التقاط الشاشة' : 'The screen could not be captured'));
        return;
      }
      const frame = cmd.result_data as unknown as RemoteDesktopFrame | null;
      if (cmd.status === 'completed' && frame) {
        setHttpFrame(frame);
        if (frame.displays?.length) setDisplays(frame.displays);
        if (frame.jpeg_base64 && canvasRef.current) {
          await drawJpegBase64(canvasRef.current, frame.jpeg_base64, frame.width, frame.height);
          setHasPicture(true);
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        if (err.code === 'consent_pending' || err.code === 'no_remote_session') void loadStatus();
        else if (err.code.startsWith('profile_forbids_')) setStreamNote(policyText(locale).codes[err.code] ?? err.message);
        else setError(err);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [displayIndex, ep.id, hasPicture, isAr, loadStatus, online, quality, scale, locale]);

  useEffect(() => {
    if (!useHttp) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      while (active) {
        await captureNextFrame();
        if (!active) break;
        await new Promise<void>((r) => {
          timer = setTimeout(r, 750);
        });
      }
    };
    void loop();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [useHttp, captureNextFrame]);

  // A new session starts without the previous picture.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger.
  useEffect(() => {
    setHasPicture(false);
    setStats(null);
    setHello(null);
    setClipIn(null);
    setClipNote(null);
    const c = canvasRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }, [sessionId]);

  // ── Start / stop ──
  /**
   * Sends the session request from the connect dialog (reason, profile, step-up token). The access
   * policy is evaluated by the API; a refusal comes back to the dialog with its code.
   */
  async function requestSession(choice: ConnectChoice): Promise<ApiError | null> {
    setBusy('start');
    setError(null);
    setLastEnded(null);
    try {
      await api(`/endpoints/${ep.id}/remote-desktop/start`, {
        method: 'POST',
        body: { display_index: displayIndex, quality, scale, ...choice },
      });
      setConnectOpen(false);
      await loadStatus();
      onReload();
      return null;
    } catch (err) {
      return err instanceof ApiError ? err : new ApiError(0, 'error', String(err));
    } finally {
      setBusy('');
    }
  }

  async function stopSession() {
    setBusy('stop');
    setError(null);
    try {
      await api(`/endpoints/${ep.id}/remote-desktop/stop`, { method: 'POST', body: {} });
      await loadStatus();
      onReload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  // ── Input ──
  const mayControl = live && online && canControl && !viewOnly && interactive && allows('control');

  async function sendInput(ev: Record<string, unknown>) {
    if (!mayControl) return;
    const full: Record<string, unknown> = { display_index: displayIndex, ...ev };
    if (wsLive && sendWs({ t: 'input', ev: full })) return;
    if (full.kind === 'mouse_move' || full.kind === 'mouse_down' || full.kind === 'mouse_up' || full.kind === 'mouse_wheel') return; // live stream only
    const { kind, ...rest } = full;
    try {
      await api(`/endpoints/${ep.id}/commands?wait_ms=1200`, { method: 'POST', body: { kind: 'rd_input', event_kind: kind, ...rest } });
      setTimeout(() => void captureNextFrame(), 120);
    } catch (err) {
      setError(err as ApiError);
    }
  }

  function pointer(e: React.MouseEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000, button };
  }

  /** Canvas mouse handlers: the live stream carries moves, presses and the wheel; HTTP carries clicks. */
  const canvasHandlers = {
    onMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!mayControl || !wsLive) return;
      const now = performance.now();
      if (now - lastMove.current < 50) return;
      lastMove.current = now;
      const p = pointer(e);
      if (p) void sendInput({ kind: 'mouse_move', x: p.x, y: p.y });
    },
    onMouseDown: (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!mayControl || !wsLive) return;
      viewportRef.current?.focus();
      const p = pointer(e);
      if (p) void sendInput({ kind: 'mouse_down', ...p });
    },
    onMouseUp: (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!mayControl || !wsLive) return;
      const p = pointer(e);
      if (p) void sendInput({ kind: 'mouse_up', ...p });
    },
    onClick: (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!mayControl || wsLive) return;
      const p = pointer(e);
      if (p) void sendInput({ kind: 'mouse_click', ...p });
    },
    onDoubleClick: (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!mayControl || wsLive) return;
      const p = pointer(e);
      if (p) void sendInput({ kind: 'mouse_click', ...p, double: true });
    },
    onContextMenu: (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (!mayControl || wsLive) return;
      const p = pointer(e);
      if (p) void sendInput({ kind: 'mouse_click', ...p, button: 'right' });
    },
    onWheel: (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (!mayControl || !wsLive) return;
      const p = pointer(e);
      const lines = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      // Browser: positive = scroll down; Windows wheel data: positive = up.
      const delta = Math.max(-2400, Math.min(2400, Math.round(-lines)));
      if (p && delta !== 0) void sendInput({ kind: 'mouse_wheel', x: p.x, y: p.y, delta_y: delta });
    },
  };

  function onViewportKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!mayControl) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
    e.preventDefault();
    // By position: the physical key goes down and up, so the remote layout (and held modifiers)
    // decide; live stream only (the HTTP fallback has no key_down/key_up).
    if (keyMode === 'position' && wsLive && e.code) {
      void sendInput({ kind: 'key_down', code: e.code });
      return;
    }
    void sendInput({ kind: 'key_press', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
  }
  function onViewportKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!mayControl || keyMode !== 'position' || !wsLive || !e.code) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
    e.preventDefault();
    void sendInput({ kind: 'key_up', code: e.code });
  }

  // ── Clipboard (live stream only; each transfer is audited by the API) ──
  function sendClipboard() {
    if (clipOut.length > MAX_CLIPBOARD) return;
    reqSeq.current += 1;
    if (!sendWs({ t: 'clipboard_set', req: `s${reqSeq.current}`, text: clipOut })) setClipNote({ tone: 'crit', text: 'needs_stream' });
  }
  function getClipboard() {
    reqSeq.current += 1;
    if (!sendWs({ t: 'clipboard_get', req: `g${reqSeq.current}` })) setClipNote({ tone: 'crit', text: 'needs_stream' });
  }

  function requestFull() {
    if (wsLive) sendWs({ t: 'full' });
    else void captureNextFrame();
  }

  // The consent answer time (attended) or the refuse window (unattended) runs from the request, or
  // from the approval when a second admin approved it.
  const fsNow = status?.fleet_session ?? null;
  const consentWindow = fsNow ? (fsNow.consent_mode === 'prompt' ? fsNow.consent_timeout_s : fsNow.refuse_window_s) || 60 : 60;
  const consentFrom = fsNow ? new Date(fsNow.approval_decided_at ?? fsNow.started_at).getTime() : 0;
  const consentLeft = fsNow && state === 'waiting_consent' ? Math.max(0, consentWindow - Math.floor((Date.now() - consentFrom) / 1000)) : null;
  const approvalLeft = fsNow?.approval_expires_at && state === 'waiting_approval' ? Math.max(0, Math.floor((new Date(fsNow.approval_expires_at).getTime() - Date.now()) / 1000)) : null;

  return {
    locale,
    isAr,
    session,
    state,
    live,
    status,
    fleetSession: status?.fleet_session ?? null,
    lastEnded,
    consentLeft,
    approvalLeft,
    permissions,
    allows,
    interactive,
    setInteractive,
    displayIndex,
    setDisplayIndex,
    quality,
    setQuality,
    scale,
    setScale,
    adaptive,
    setAdaptive,
    connectOpen,
    setConnectOpen,
    path: useHttp && path === 'waiting' ? ('http' as RdPath) : path,
    wsLive,
    hello,
    displays,
    stats,
    httpFrame,
    hasPicture,
    rttMs,
    streamNote,
    textToType,
    setTextToType,
    clipOut,
    setClipOut,
    clipIn,
    clipNote,
    sendClipboard,
    getClipboard,
    busy,
    error,
    viewportRef,
    canvasRef,
    canvasHandlers,
    onViewportKey,
    onViewportKeyUp,
    keyMode,
    setKeyMode,
    sendWs,
    toolListeners,
    mayControl,
    requestSession,
    stopSession,
    sendInput,
    requestFull,
  };
}
