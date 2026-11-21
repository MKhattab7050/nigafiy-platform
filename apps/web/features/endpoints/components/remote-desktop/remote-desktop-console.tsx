'use client';

import clsx from 'clsx';
import { Keyboard, Maximize2, Monitor, MousePointer, Play, RefreshCw, Square } from 'lucide-react';
import { Badge, Button, Card, ErrorNote, Input, Select } from '@/components/ui';
import { RemoteDesktopConsoleProps, useRemoteDesktop } from './use-remote-desktop';

export function RemoteDesktopConsole(props: RemoteDesktopConsoleProps) {
  const { ep, online, canControl, viewOnly = false, onReload } = props;
  const { locale, isAr, streaming, setStreaming, interactive, setInteractive, displayIndex, setDisplayIndex, quality, setQuality, scale, setScale, adaptive, setAdaptive, frame, setFrame, rttMs, setRttMs, textToType, setTextToType, busy, setBusy, error, setError, viewportRef, inFlightRef, captureNextFrame, startSession, stopSession, sendInput, handleCanvasMouse, displays } = useRemoteDesktop(props);

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
              {frame.width}×{frame.height} (<span dir="auto">{isAr ? 'المصدر' : 'src'}</span> {frame.source_width}×{frame.source_height})
            </span>
            {frame.unchanged ? (
              <span dir="auto">· {isAr ? 'الشاشة لم تتغيّر (لم تُرسل صورة)' : 'screen unchanged (no image sent)'}</span>
            ) : (
              <span>· {(frame.byte_length / 1024).toFixed(1)} KB</span>
            )}
            <span dir="auto">· {isAr ? `التقاط ${frame.capture_ms}ms` : `capture ${frame.capture_ms}ms`}</span>
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
              aria-label={isAr ? 'الشاشة' : 'Display'}
            >
              {displays.map((d) => (
                <option key={d.index} value={d.index}>
                  {d.width > 0 && d.height > 0 ? `${d.name} (${d.width}×${d.height})` : d.name}
                </option>
              ))}
            </Select>

            <Select
              value={String(scale)}
              onChange={(e) => setScale(Number(e.target.value))}
              aria-label={isAr ? 'الدقة' : 'Scale'}
            >
              <option value="0.5">{isAr ? 'الدقة 50% (سريع)' : 'Scale 50% (Fast)'}</option>
              <option value="0.75">{isAr ? 'الدقة 75% (متوازن)' : 'Scale 75% (Balanced)'}</option>
              <option value="1">{isAr ? 'الدقة 100% (كاملة)' : 'Scale 100% (Full HD)'}</option>
            </Select>

            <Select
              value={String(quality)}
              onChange={(e) => setQuality(Number(e.target.value))}
              aria-label={isAr ? 'الجودة' : 'Quality'}
            >
              <option value="45">{isAr ? 'جودة منخفضة (45%)' : 'Low Quality (45%)'}</option>
              <option value="68">{isAr ? 'جودة متوسطة (68%)' : 'Medium Quality (68%)'}</option>
              <option value="85">{isAr ? 'جودة عالية (85%)' : 'High Quality (85%)'}</option>
            </Select>

            <label className="flex items-center gap-1.5 text-xs text-muted px-1">
              <input type="checkbox" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} />
              {isAr ? 'جودة تلقائية' : 'Adaptive'}
            </label>


            {canControl && !viewOnly && (
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
          {canControl && !viewOnly && (
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
                alt={isAr ? 'بث سطح المكتب البعيد' : 'Remote Desktop Stream'}
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
