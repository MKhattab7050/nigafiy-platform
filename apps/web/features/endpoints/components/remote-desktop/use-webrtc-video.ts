import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';

/*
 * WebRTC video for the live Remote Desktop console (docs/features/fleet-pro.md "WebRTC video").
 *
 * The browser offers one receive-only H.264 video transceiver and one data channel "input"; the
 * signalling (rtc_offer / rtc_answer / rtc_ice) goes over the session's existing stream socket and
 * the API checks and audits it. Video frames are drawn onto the console's canvas, so the drawing
 * layer, the monitor windows and the pointer handlers work exactly as with the JPEG stream.
 *
 * LAN first: no TURN relay; STUN only when the administrator configured it (ice_servers in the
 * session message, empty by default). Whenever WebRTC is not possible or stops working the
 * console goes back to the WebSocket + JPEG stream ("compatibility") on its own, and tells the API
 * why (rtc_fallback): no RTCPeerConnection or no H.264 decoder, refused, no answer within 8 s, no
 * video within 10 s, ICE failed or disconnected for 5 s, the agent's encoder failed.
 */

export type RtcMode = 'off' | 'starting' | 'active' | 'jpeg';

export type RtcFallbackReason =
  | 'no_rtc'
  | 'no_h264'
  | 'refused'
  | 'answer_timeout'
  | 'no_video'
  | 'ice_failed'
  | 'ice_disconnected'
  | 'encoder_failed'
  | 'recording'
  | 'agent_failed'
  | 'error';

/** Measured in this browser (getStats), plus what the agent reports about its encoder. */
export interface RtcStats {
  fps: number;
  kbps: number;
  width: number;
  height: number;
  /** The agent's target bitrate (follows packet loss) and its measured loss. */
  targetKbps: number | null;
  lossPct: number | null;
}

const ANSWER_TIMEOUT_MS = 8_000;
const VIDEO_TIMEOUT_MS = 10_000;
const DISCONNECTED_MS = 5_000;

interface Options {
  /** Live stream open and the session active. */
  wsLive: boolean;
  /** The API allows WebRTC (session message), the agent offers it (hello), no recording. */
  available: boolean;
  iceServers: string[];
  sendWs: (m: Record<string, unknown>) => boolean;
  listeners: MutableRefObject<Set<(m: Record<string, unknown> | ArrayBuffer) => void>>;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  onPicture: () => void;
}

/** Whether this browser can receive H.264 over WebRTC at all (null: no RTCPeerConnection). */
function browserSupport(): RtcFallbackReason | null {
  if (typeof window === 'undefined' || typeof window.RTCPeerConnection !== 'function') return 'no_rtc';
  const caps = typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities ? RTCRtpReceiver.getCapabilities('video') : null;
  if (caps && !caps.codecs.some((c) => c.mimeType.toLowerCase() === 'video/h264')) return 'no_h264';
  return null;
}

function failCode(code: unknown): RtcFallbackReason {
  if (code === 'encoder_failed' || code === 'ice_failed') return code;
  if (typeof code === 'string' && code.startsWith('webrtc_')) return 'refused';
  return 'agent_failed';
}

export function useWebRtcVideo({ wsLive, available, iceServers, sendWs, listeners, canvasRef, onPicture }: Options) {
  /** The operator's choice: WebRTC when possible, or compatibility (JPEG) only. */
  const [preferred, setPreferred] = useState(true);
  const [mode, setMode] = useState<RtcMode>('off');
  const [reason, setReason] = useState<RtcFallbackReason | null>(null);
  const [encoder, setEncoder] = useState<string | null>(null);
  const [stats, setStats] = useState<RtcStats | null>(null);
  /** Bumped by "Try WebRTC again". */
  const [attempt, setAttempt] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const modeRef = useRef<RtcMode>('off');
  const encoderRef = useRef<string | null>(null);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const onPictureRef = useRef(onPicture);
  onPictureRef.current = onPicture;
  const iceRef = useRef(iceServers);
  iceRef.current = iceServers;
  const iceKey = iceServers.join(',');

  const setModeBoth = useCallback((m: RtcMode) => {
    modeRef.current = m;
    setMode(m);
  }, []);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const teardown = useCallback(() => {
    clearTimers();
    dcRef.current = null;
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    const v = videoRef.current;
    if (v) {
      v.srcObject = null;
      v.remove();
    }
    videoRef.current = null;
    setStats(null);
  }, [clearTimers]);

  /** Back to JPEG for this socket; `tell` sends the reason to the API (audited). */
  const fallBack = useCallback(
    (why: RtcFallbackReason, tell = true) => {
      if (modeRef.current === 'jpeg') return;
      teardown();
      setReason(why);
      setModeBoth('jpeg');
      if (tell) sendWs({ t: 'rtc_fallback', reason: why });
    },
    [sendWs, setModeBoth, teardown],
  );

  // Signalling and state from the agent (through the API), on the stream socket.
  useEffect(() => {
    const onMessage = (m: Record<string, unknown> | ArrayBuffer) => {
      if (m instanceof ArrayBuffer) return;
      const pc = pcRef.current;
      switch (m.t) {
        case 'rtc_answer':
          if (!pc || typeof m.sdp !== 'string') return;
          clearTimers();
          timers.current.push(setTimeout(() => fallBack('no_video'), VIDEO_TIMEOUT_MS));
          pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => fallBack('error'));
          return;
        case 'rtc_ice': {
          const c = m.candidate as RTCIceCandidateInit | null;
          if (pc && c?.candidate) pc.addIceCandidate(c).catch(() => undefined);
          return;
        }
        case 'rtc_refused':
          // Already audited by the API as a refusal.
          if (modeRef.current === 'starting') fallBack('refused', false);
          return;
        case 'rtc_state':
          if (typeof m.encoder === 'string' && m.encoder) {
            encoderRef.current = m.encoder;
            setEncoder(m.encoder);
          }
          if (m.state === 'failed' && (modeRef.current === 'starting' || modeRef.current === 'active')) fallBack(failCode(m.code));
          return;
        case 'rtc_closed':
          // The API moved this viewer back to JPEG (recording switched on, view taken away).
          fallBack(m.reason === 'recording' ? 'recording' : 'refused', false);
          return;
        case 'rtc_stats':
          if (typeof m.encoder === 'string' && m.encoder) setEncoder(m.encoder);
          setStats((s) => (s ? { ...s, targetKbps: Number(m.bitrate_kbps) || null, lossPct: typeof m.loss_pct === 'number' ? m.loss_pct : null } : s));
          return;
        case 'recording':
          if (m.on === true && modeRef.current !== 'jpeg' && modeRef.current !== 'off') fallBack('recording', false);
          return;
      }
    };
    const set = listeners.current;
    set.add(onMessage);
    return () => {
      set.delete(onMessage);
    };
  }, [listeners, fallBack, clearTimers]);

  // Start when everything allows it; stop when the socket or the session goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    if (!wsLive || !available || !preferred) {
      if (modeRef.current === 'starting' || modeRef.current === 'active') {
        sendWs({ t: 'rtc_close' });
        teardown();
      }
      setModeBoth(available && wsLive ? 'jpeg' : 'off');
      if (!preferred && available && wsLive) setReason(null);
      return;
    }
    const unsupported = browserSupport();
    if (unsupported) {
      fallBack(unsupported);
      return;
    }
    setReason(null);
    setModeBoth('starting');
    let cancelled = false;
    const stun = iceRef.current;
    const pc = new RTCPeerConnection({ iceServers: stun.length ? [{ urls: stun }] : [] });
    pcRef.current = pc;
    const tr = pc.addTransceiver('video', { direction: 'recvonly' });
    // H.264 first (the agent sends nothing else).
    const caps = RTCRtpReceiver.getCapabilities?.('video');
    if (caps && typeof tr.setCodecPreferences === 'function') {
      const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
      if (h264.length) tr.setCodecPreferences(h264);
    }
    const dc = pc.createDataChannel('input', { ordered: true });
    dc.onopen = () => {
      if (pcRef.current === pc) dcRef.current = dc;
    };
    dc.onclose = () => {
      if (dcRef.current === dc) dcRef.current = null;
    };
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) sendWs({ t: 'rtc_ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pcRef.current !== pc) return;
      if (pc.connectionState === 'failed') fallBack('ice_failed');
      else if (pc.connectionState === 'disconnected') {
        timers.current.push(
          setTimeout(() => {
            if (pcRef.current === pc && pc.connectionState === 'disconnected') fallBack('ice_disconnected');
          }, DISCONNECTED_MS),
        );
      }
    };
    pc.ontrack = (e) => {
      if (pcRef.current !== pc) return;
      // An off-screen video element decodes; each decoded frame is drawn on the console's canvas.
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
      v.setAttribute('aria-hidden', 'true');
      document.body.appendChild(v);
      v.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      videoRef.current = v;
      const draw = () => {
        if (videoRef.current !== v) return;
        const c = canvasRef.current;
        if (c && v.videoWidth > 0) {
          if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
            c.width = v.videoWidth;
            c.height = v.videoHeight;
          }
          c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
          if (modeRef.current === 'starting') {
            clearTimers();
            setModeBoth('active');
            onPictureRef.current();
            // The first frame is decoded: the API stops counting this viewer for JPEG (audited).
            sendWs({ t: 'rtc_active', ...(encoderRef.current ? { encoder: encoderRef.current.slice(0, 160) } : {}) });
          }
        }
        if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(draw);
        else requestAnimationFrame(draw);
      };
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(draw);
      else requestAnimationFrame(draw);
      void v.play().catch(() => undefined);
    };
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (cancelled || !pc.localDescription) return;
        if (!sendWs({ t: 'rtc_offer', sdp: pc.localDescription.sdp })) {
          fallBack('error', false);
          return;
        }
        timers.current.push(setTimeout(() => fallBack('answer_timeout'), ANSWER_TIMEOUT_MS));
      } catch {
        fallBack('error');
      }
    })();
    return () => {
      cancelled = true;
      if (pcRef.current === pc) {
        if (modeRef.current === 'starting' || modeRef.current === 'active') sendWs({ t: 'rtc_close' });
        teardown();
        setModeBoth('off');
      }
    };
  }, [wsLive, available, preferred, attempt, iceKey, sendWs, teardown, fallBack, setModeBoth, canvasRef, clearTimers]);

  // Measured in this browser: frames per second and bits per second received, every second.
  useEffect(() => {
    if (mode !== 'active') return;
    let last: { t: number; bytes: number; frames: number } | null = null;
    const t = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      const report = await pc.getStats().catch(() => null);
      report?.forEach((s) => {
        if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
        const now = s.timestamp as number;
        const bytes = Number(s.bytesReceived) || 0;
        const frames = Number(s.framesDecoded) || 0;
        const prev = last;
        if (prev && now > prev.t) {
          const sec = (now - prev.t) / 1000;
          const fps = typeof s.framesPerSecond === 'number' ? s.framesPerSecond : (frames - prev.frames) / sec;
          setStats((p) => ({
            fps: Math.round(fps * 10) / 10,
            kbps: Math.round(((bytes - prev.bytes) * 8) / 1000 / sec),
            width: Number(s.frameWidth) || 0,
            height: Number(s.frameHeight) || 0,
            targetKbps: p?.targetKbps ?? null,
            lossPct: p?.lossPct ?? null,
          }));
        }
        last = { t: now, bytes, frames };
      });
    }, 1_000);
    return () => clearInterval(t);
  }, [mode]);

  /** Input over the data channel while video plays (the agent checks it like the socket path). */
  const sendInput = useCallback((ev: Record<string, unknown>): boolean => {
    const dc = dcRef.current;
    if (modeRef.current !== 'active' || !dc || dc.readyState !== 'open') return false;
    dc.send(JSON.stringify(ev));
    return true;
  }, []);

  const retry = useCallback(() => {
    setPreferred(true);
    setModeBoth('off');
    setAttempt((n) => n + 1);
  }, [setModeBoth]);

  return { mode, reason, encoder, stats, preferred, setPreferred, retry, sendInput, active: mode === 'active' };
}
