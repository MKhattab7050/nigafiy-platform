import { useCallback, useEffect, useRef, useState } from 'react';
import type { EndpointCommand, EndpointDetail, RemoteDesktopFrame } from '@lan-detective/shared-types';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export interface RemoteDesktopConsoleProps {
  ep: EndpointDetail;
  online: boolean;
  /** May start and stop sessions. */
  canControl: boolean;
  /** The agent cannot inject mouse/keyboard input on this platform (macOS). */
  viewOnly?: boolean;
  onReload: () => void;
}

/** Session, frame polling and input of the live remote desktop; the component only renders. */
export function useRemoteDesktop({ ep, online, canControl, viewOnly = false, onReload }: RemoteDesktopConsoleProps) {
  const { locale } = useI18n();
  const isAr = locale === 'ar';

  const [streaming, setStreaming] = useState<boolean>(Boolean(ep.rd_session));
  const [interactive, setInteractive] = useState<boolean>(true);
  const [displayIndex, setDisplayIndex] = useState<number>(ep.rd_session?.display_index ?? 0);
  const [quality, setQuality] = useState<number>(ep.rd_session?.quality ?? 68);
  const [scale, setScale] = useState<number>(ep.rd_session?.scale ?? 0.75);
  const [adaptive, setAdaptive] = useState<boolean>(true);

  const [frame, setFrame] = useState<RemoteDesktopFrame | null>(ep.last_rd_frame ?? null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [textToType, setTextToType] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const inFlightRef = useRef(false);
  const hasImageRef = useRef(false);
  hasImageRef.current = Boolean(frame?.jpeg_base64);
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(inputTimerRef.current);
      if (streamingRef.current) {
        void api('/endpoints/' + ep.id + '/remote-desktop/stop', { method: 'POST' }).catch(() => undefined);
      }
    };
  }, [ep.id]);

  useEffect(() => {
    if (ep.last_rd_frame && !frame) {
      setFrame(ep.last_rd_frame);
    }
  }, [ep.last_rd_frame, frame]);

  const captureNextFrame = useCallback(async () => {
    if (!online || inFlightRef.current) return;
    inFlightRef.current = true;
    const t0 = performance.now();
    try {
      const cmd = await api<EndpointCommand>(`/endpoints/${ep.id}/commands?wait_ms=3500`, {
        method: 'POST',
        body: {
          kind: 'rd_capture',
          display_index: displayIndex,
          quality,
          scale,
          // Without an image on screen, ask for one even if the agent's screen has not changed.
          ...(hasImageRef.current ? {} : { full_frame: true }),
        },
      });
      const elapsed = Math.round(performance.now() - t0);
      setRttMs(elapsed);
      if (cmd.status === 'failed') {
        // The agent could not read the screen (e.g. no interactive desktop). Retrying would only repeat it.
        setError(new ApiError(0, 'capture_failed', cmd.error ?? (isAr ? 'تعذّر التقاط الشاشة' : 'The screen could not be captured')));
        setStreaming(false);
        return;
      }
      if (cmd.status === 'completed' && cmd.result_data) {
        const nextFrame = cmd.result_data as unknown as RemoteDesktopFrame;
        // Unchanged screen (or an image no longer available): keep showing the current picture.
        setFrame((prev) => (nextFrame.jpeg_base64 ? nextFrame : prev ? { ...nextFrame, jpeg_base64: prev.jpeg_base64 } : prev));
        // Adaptive quality adjustment based on round-trip latency
        if (adaptive) {
          if (elapsed > 1400 && quality > 45) {
            setQuality(45);
            setScale(0.5);
          } else if (elapsed < 450 && quality < 68) {
            setQuality(68);
          }
        }
      }
    } catch (err) {
      // A refused request (session ended elsewhere, endpoint offline, no permission) stops the stream;
      // only network hiccups are retried by the next loop iteration.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setError(err);
        setStreaming(false);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [adaptive, displayIndex, ep.id, online, quality, scale]);

  useEffect(() => {
    if (!streaming || !online) return;
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
  }, [streaming, online, captureNextFrame]);

  async function startSession() {
    setBusy('start');
    setError(null);
    try {
      const res = await api<{ last_frame: RemoteDesktopFrame | null }>(`/endpoints/${ep.id}/remote-desktop/start`, {
        method: 'POST',
        body: {
          display_index: displayIndex,
          quality,
          scale,
        },
      });
      if (res.last_frame) setFrame(res.last_frame);
      setStreaming(true);
      onReload();
      await captureNextFrame();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function stopSession() {
    setBusy('stop');
    setError(null);
    try {
      await api(`/endpoints/${ep.id}/remote-desktop/stop`, { method: 'POST', body: {} });
      setStreaming(false);
      onReload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function sendInput(payload: Record<string, unknown>) {
    if (!online || !canControl || viewOnly || !interactive) return;
    try {
      await api(`/endpoints/${ep.id}/commands?wait_ms=1200`, {
        method: 'POST',
        body: {
          kind: 'rd_input',
          display_index: displayIndex,
          ...payload,
        },
      });
      clearTimeout(inputTimerRef.current);
      inputTimerRef.current = setTimeout(() => void captureNextFrame(), 120);
    } catch (err) {
      setError(err as ApiError);
    }
  }

  function handleCanvasMouse(e: React.MouseEvent<HTMLImageElement>, eventKind: 'mouse_click' | 'mouse_move', double = false) {
    if (!interactive || !canControl || viewOnly) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    void sendInput({
      event_kind: eventKind,
      x: Math.round(x * 10000) / 10000,
      y: Math.round(y * 10000) / 10000,
      button,
      double,
    });
  }

  const displays = frame?.displays ?? [
    { index: 0, name: isAr ? 'الشاشة الرئيسية (1)' : 'Primary Display (1)', x: 0, y: 0, width: 1920, height: 1080, primary: true },
  ];
  return { locale, isAr, streaming, setStreaming, interactive, setInteractive, displayIndex, setDisplayIndex, quality, setQuality, scale, setScale, adaptive, setAdaptive, frame, setFrame, rttMs, setRttMs, textToType, setTextToType, busy, setBusy, error, setError, viewportRef, inFlightRef, captureNextFrame, startSession, stopSession, sendInput, handleCanvasMouse, displays };
}
