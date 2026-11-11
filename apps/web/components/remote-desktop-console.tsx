'use client';

import clsx from 'clsx';
import { Keyboard, Maximize2, Monitor, MousePointer, Play, RefreshCw, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EndpointCommand, EndpointDetail, RemoteDesktopFrame } from '@lan-detective/shared-types';
import { Badge, Button, Card, ErrorNote, Input, Select } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export function RemoteDesktopConsole({
  ep,
  online,
  canControl,
  onReload,
}: {
  ep: EndpointDetail;
  online: boolean;
  canControl: boolean;
  onReload: () => void;
}) {
  const { locale } = useI18n();
  const isAr = locale === 'ar';

  const [streaming, setStreaming] = useState<boolean>(Boolean(ep.rd_session));
  const [interactive, setInteractive] = useState<boolean>(true);
  const [displayIndex, setDisplayIndex] = useState<number>(ep.rd_session?.display_index ?? 0);
  const [quality, setQuality] = useState<number>(ep.rd_session?.quality ?? 68);
  const [scale, setScale] = useState<number>(ep.rd_session?.scale ?? 0.75);
  const [adaptive, setAdaptive] = useState<boolean>(true);
  const [recording, setRecording] = useState<boolean>(ep.rd_session?.recording_enabled ?? false);

  const [frame, setFrame] = useState<RemoteDesktopFrame | null>(ep.last_rd_frame ?? null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [textToType, setTextToType] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const inFlightRef = useRef(false);

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
        },
      });
      const elapsed = Math.round(performance.now() - t0);
      setRttMs(elapsed);
      if (cmd.status === 'failed') {
        // The agent could not read the screen (e.g. no interactive desktop). Retrying would only repeat it.
        setError(new ApiError(0, 'capture_failed', cmd.error ?? 'The screen could not be captured'));
        setStreaming(false);
        return;
      }
      if (cmd.status === 'completed' && cmd.result_data) {
        const nextFrame = cmd.result_data as unknown as RemoteDesktopFrame;
        setFrame(nextFrame);
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
    const loop = async () => {
      while (active) {
        await captureNextFrame();
        await new Promise((r) => setTimeout(r, 750));
      }
    };
    void loop();
    return () => {
      active = false;
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
          recording_enabled: recording,
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
    if (!online || !canControl || !interactive) return;
    try {
      await api(`/endpoints/${ep.id}/commands?wait_ms=1200`, {
        method: 'POST',
        body: {
          kind: 'rd_input',
          display_index: displayIndex,
          ...payload,
        },
      });
      setTimeout(() => void captureNextFrame(), 120);
    } catch (err) {
      setError(err as ApiError);
    }
  }

  function handleCanvasMouse(e: React.MouseEvent<HTMLImageElement>, eventKind: 'mouse_click' | 'mouse_move', double = false) {
    if (!interactive || !canControl) return;
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
    { index: 0, name: 'Primary Display (1)', x: 0, y: 0, width: 1920, height: 1080, primary: true },
  ];

  return (
    <div className="space-y-4">
      {error && <ErrorNote error={error} />}

      {/* Transparency & Consent Notice */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-raised/60 px-3.5 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={streaming ? 'ok' : 'idle'}>
            {streaming ? (isAr ? 'جلسة نشطة' : 'LIVE SESSION') : isAr ? 'متوقف' : 'IDLE'}
          </Badge>
          <span className="text-muted">
            {isAr
              ? 'عند بدء الجلسة وانتهائها يظهر إشعار على شاشة الجهاز باسمك، وتُسجَّل الجلسة في سجل التدقيق.'
              : 'Starting or ending a session shows a notice with your name on the endpoint’s screen, and the session is recorded in the audit log.'}
          </span>
        </div>
        {frame && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] mono text-muted" dir="ltr">
            <span>
              {frame.width}×{frame.height} (src {frame.source_width}×{frame.source_height})
            </span>
            <span>· {(frame.byte_length / 1024).toFixed(1)} KB</span>
            <span>· capture {frame.capture_ms}ms</span>
            {rttMs !== null && <span>· RTT {rttMs}ms</span>}
            <Badge tone={frame.capture_mode === 'native_gdi' || frame.capture_mode === 'native' ? 'ok' : 'info'}>
              {frame.capture_mode}
            </Badge>
          </div>
        )}
      </div>

      <Card
        title={isAr ? 'وحدة التحكم بسطح المكتب البعيد (Remote Desktop)' : 'Remote Desktop Console'}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={String(displayIndex)}
              onChange={(e) => setDisplayIndex(Number(e.target.value))}
              aria-label="Display"
            >
              {displays.map((d) => (
                <option key={d.index} value={d.index}>
                  {d.name} ({d.width}×{d.height})
                </option>
              ))}
            </Select>

            <Select
              value={String(scale)}
              onChange={(e) => setScale(Number(e.target.value))}
              aria-label="Scale"
            >
              <option value="0.5">{isAr ? 'الدقة 50% (سريع)' : 'Scale 50% (Fast)'}</option>
              <option value="0.75">{isAr ? 'الدقة 75% (متوازن)' : 'Scale 75% (Balanced)'}</option>
              <option value="1">{isAr ? 'الدقة 100% (كاملة)' : 'Scale 100% (Full HD)'}</option>
            </Select>

            <Select
              value={String(quality)}
              onChange={(e) => setQuality(Number(e.target.value))}
              aria-label="Quality"
            >
              <option value="45">{isAr ? 'جودة منخفضة (45%)' : 'Low Quality (45%)'}</option>
              <option value="68">{isAr ? 'جودة متوسطة (68%)' : 'Medium Quality (68%)'}</option>
              <option value="85">{isAr ? 'جودة عالية (85%)' : 'High Quality (85%)'}</option>
            </Select>

            <label className="flex items-center gap-1.5 text-xs text-muted px-1">
              <input type="checkbox" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} />
              {isAr ? 'جودة تلقائية' : 'Adaptive'}
            </label>

            <label className="flex items-center gap-1.5 text-xs text-muted px-1">
              <input
                type="checkbox"
                checked={recording}
                disabled={streaming}
                onChange={(e) => setRecording(e.target.checked)}
              />
              {isAr ? 'تسجيل الجلسة' : 'Record session'}
            </label>

            {canControl && (
              <Button
                size="sm"
                onClick={() => setInteractive((v) => !v)}
                className={clsx(interactive && 'border-accent text-fg')}
              >
                <MousePointer className="size-3.5" aria-hidden />
                {interactive ? (isAr ? 'التحكم مفعّل' : 'Control ON') : isAr ? 'مشاهدة فقط' : 'View Only'}
              </Button>
            )}

            <Button
              size="sm"
              disabled={!online}
              onClick={() => void captureNextFrame()}
              title={isAr ? 'التقاط إطار الآن' : 'Capture snapshot now'}
            >
              <RefreshCw className="size-3.5" aria-hidden />
            </Button>

            <Button
              size="sm"
              onClick={() => {
                if (viewportRef.current?.requestFullscreen) {
                  void viewportRef.current.requestFullscreen();
                }
              }}
              title={isAr ? 'ملء الشاشة' : 'Fullscreen'}
            >
              <Maximize2 className="size-3.5" aria-hidden />
            </Button>

            {!streaming ? (
              <Button
                size="sm"
                variant="primary"
                disabled={!online || !canControl}
                busy={busy === 'start'}
                onClick={() => void startSession()}
              >
                <Play className="size-3.5" aria-hidden />
                {isAr ? 'بدء البث الحي' : 'Start Live Session'}
              </Button>
            ) : (
              <Button size="sm" variant="danger" busy={busy === 'stop'} onClick={() => void stopSession()}>
                <Square className="size-3.5" aria-hidden />
                {isAr ? 'إنهاء الجلسة' : 'Stop Session'}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-3">
          {/* Keyboard & Special Keys Bar */}
          {canControl && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-bg/60 p-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!textToType) return;
                  void sendInput({ event_kind: 'text', text: textToType });
                  setTextToType('');
                }}
                className="flex flex-1 items-center gap-1.5 min-w-60"
              >
                <Keyboard className="size-4 text-muted shrink-0" aria-hidden />
                <Input
                  value={textToType}
                  onChange={(e) => setTextToType(e.target.value)}
                  placeholder={isAr ? 'اكتب نصاً لإرساله للجهاز البعيد…' : 'Type text to send to remote screen…'}
                />
                <Button type="submit" size="sm" disabled={!online || !textToType}>
                  {isAr ? 'إرسال نص' : 'Send Text'}
                </Button>
              </form>

              <div className="flex flex-wrap items-center gap-1" dir="ltr">
                {(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const).map(
                  (k) => (
                    <Button
                      key={k}
                      size="sm"
                      disabled={!online || !interactive}
                      onClick={() => void sendInput({ event_kind: 'key_press', key: k })}
                    >
                      {k.replace('Arrow', '')}
                    </Button>
                  ),
                )}
              </div>
            </div>
          )}

          {/* Screen Viewport */}
          <div
            ref={viewportRef}
            tabIndex={0}
            onKeyDown={(e) => {
              if (!interactive || !streaming) return;
              // Avoid hijacking typing when focus is inside an input
              if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
              e.preventDefault();
              void sendInput({
                event_kind: 'key_press',
                key: e.key,
                ctrl: e.ctrlKey,
                alt: e.altKey,
                shift: e.shiftKey,
              });
            }}
            className="relative flex min-h-[420px] items-center justify-center overflow-hidden rounded-lg border border-line-strong bg-black focus:outline-2 focus:outline-accent"
          >
            {frame?.jpeg_base64 ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`data:image/jpeg;base64,${frame.jpeg_base64}`}
                alt="Remote Desktop Stream"
                className={clsx('max-h-[72vh] w-auto select-none object-contain', interactive && 'cursor-crosshair')}
                draggable={false}
                onClick={(e) => handleCanvasMouse(e, 'mouse_click', false)}
                onDoubleClick={(e) => handleCanvasMouse(e, 'mouse_click', true)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  handleCanvasMouse(e, 'mouse_click', false);
                }}
              />
            ) : (
              <div className="flex flex-col items-center gap-3 p-8 text-center text-muted">
                <Monitor className="size-10 text-faint" aria-hidden />
                <p className="text-sm font-medium text-fg">
                  {isAr ? 'سطح المكتب البعيد جاهز للاتصال' : 'Remote Desktop Ready'}
                </p>
                <p className="max-w-md text-xs">
                  {isAr
                    ? 'اضغط "بدء البث الحي" لالتقاط شاشة الجهاز البعيد والتحكم بالماوس ولوحة المفاتيح مباشرة.'
                    : 'Click "Start Live Session" to stream the endpoint display and interact via mouse and keyboard.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

