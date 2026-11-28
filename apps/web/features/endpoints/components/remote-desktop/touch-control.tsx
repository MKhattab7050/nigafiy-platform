'use client';

import clsx from 'clsx';
import { ChevronDown, ChevronUp, Hand, Keyboard, Maximize2, Minimize2, MousePointer2, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { mediaPictureBox, mediaPictureSize, pictureBox } from './picture-rect';
import { pointerThrottle } from './pointer-throttle';
import { type GestureAction, type Pt, type TouchMode, type View, createGestures, followPoint, panView, scrollToWheel, trackpadGain, zoomView } from './touch-gestures';
import { type Mods, NO_MODS, SENTINEL, anyMod, comboKeys, diffTyped, stepEvent } from './touch-keys';

/**
 * Controlling a computer from a phone or tablet (owner, 2026-11-27: "no drag, slow, no keyboard").
 * Touches on the remote picture become clicks, drags, right clicks and scrolling
 * (touch-gestures.ts); a bar on the picture opens the phone's keyboard, switches between touch and
 * touchpad, and sends the keys a phone keyboard does not have (Ctrl, Alt, Win, Esc, arrows, F-keys,
 * Ctrl+Alt+Del). It sits inside the remote screen element, so it stays in full screen.
 *
 * Mouse use on a computer is unchanged: only pointers of type "touch" come here.
 */

interface TouchHost {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  rtc?: { active: boolean };
  viewportRef: React.RefObject<HTMLDivElement | null>;
  mayControl: boolean;
  wsLive: boolean;
  isPhone: boolean;
  sendInput: (ev: Record<string, unknown>) => Promise<void> | void;
}

const MODE_KEY = 'nigafiy.rd.touchMode';
/** Moves while a finger slides: about 30 a second (a mouse uses 50 ms; a finger wants it smoother). */
const MOVE_MS = 33;
const WHEEL_MS = 40;

export function useTouchControl(host: TouchHost) {
  const { canvasRef, mayControl } = host;
  const hostRef = useRef(host);
  hostRef.current = host;

  const [touchSeen, setTouchSeen] = useState(false);
  useEffect(() => {
    if (window.matchMedia('(pointer: coarse)').matches) setTouchSeen(true);
  }, []);

  const [mode, setModeState] = useState<TouchMode>('touch');
  useEffect(() => {
    const saved = window.localStorage.getItem(MODE_KEY);
    if (saved === 'trackpad' || saved === 'touch') setModeState(saved);
  }, []);
  const setMode = useCallback((m: TouchMode) => {
    setModeState(m);
    window.localStorage.setItem(MODE_KEY, m);
  }, []);

  // ── Local zoom (pinch): the picture is magnified here; nothing is sent ──
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const resetView = useCallback(() => setView({ scale: 1, tx: 0, ty: 0 }), []);
  useEffect(() => {
    document.addEventListener('fullscreenchange', resetView);
    window.addEventListener('resize', resetView);
    return () => {
      document.removeEventListener('fullscreenchange', resetView);
      window.removeEventListener('resize', resetView);
    };
  }, [resetView]);

  const activeMedia = (): HTMLCanvasElement | HTMLVideoElement | null => {
    const h = hostRef.current;
    return h.rtc?.active && h.videoRef?.current ? h.videoRef.current : canvasRef.current;
  };

  /** The screen element as laid out (no zoom): its size, and its top-left on screen. */
  const layoutBox = () => {
    const c = activeMedia();
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const v = viewRef.current;
    return { left: r.left - v.tx, top: r.top - v.ty, width: c.offsetWidth, height: c.offsetHeight };
  };

  // ── The trackpad pointer, in picture units (0–1) ──
  const cursor = useRef<Pt>({ x: 0.5, y: 0.5 });
  const [cursorShown, setCursorShown] = useState<Pt>({ x: 0.5, y: 0.5 });

  /**
   * A screen point in picture units. `strict`: null outside the picture (a tap on the black bars
   * beside it clicks nothing); otherwise kept on the edge (a drag that leaves the picture).
   */
  const toUnit = (p: Pt, strict = false): Pt | null => {
    const c = activeMedia();
    if (!c) return null;
    const b = mediaPictureBox(c);
    if (b.width <= 0 || b.height <= 0) return null;
    const x = (p.x - b.left) / b.width;
    const y = (p.y - b.top) / b.height;
    if (strict && (x < -0.01 || x > 1.01 || y < -0.01 || y > 1.01)) return null;
    return { x: clamp01(x), y: clamp01(y) };
  };

  const send = (ev: Record<string, unknown>) => void hostRef.current.sendInput(ev);
  const mover = useRef(pointerThrottle<Pt>((u) => send({ kind: 'mouse_move', x: r4(u.x), y: r4(u.y) }), MOVE_MS));
  const wheelAcc = useRef(0);
  const wheelAt = useRef<Pt>({ x: 0.5, y: 0.5 });
  const wheel = useRef(
    pointerThrottle<null>(() => {
      const d = Math.max(-2400, Math.min(2400, Math.round(wheelAcc.current)));
      wheelAcc.current = 0;
      if (d !== 0) send({ kind: 'mouse_wheel', x: r4(wheelAt.current.x), y: r4(wheelAt.current.y), delta_y: d });
    }, WHEEL_MS),
  );
  useEffect(() => {
    const m = mover.current;
    const w = wheel.current;
    return () => {
      m.cancel();
      w.cancel();
    };
  }, []);

  /** A drag that started on the picture (one that started on the black bars sends nothing). */
  const dragging = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const moveCursor = (dx: number, dy: number) => {
    const c = activeMedia();
    if (!c) return cursor.current;
    const b = mediaPictureBox(c);
    if (b.width <= 0) return cursor.current;
    const g = trackpadGain(Math.hypot(dx, dy));
    const next = { x: clamp01(cursor.current.x + (dx * g) / b.width), y: clamp01(cursor.current.y + (dy * g) / b.height) };
    cursor.current = next;
    setCursorShown(next);
    // Zoomed in: the view follows the pointer.
    const lb = layoutBox();
    if (lb && viewRef.current.scale > 1) {
      const sz = mediaPictureSize(c);
      const pic = pictureBox({ left: 0, top: 0, width: lb.width, height: lb.height }, sz.width, sz.height);
      setView((v) => followPoint(v, { x: pic.left + next.x * pic.width, y: pic.top + next.y * pic.height }, lb));
    }
    return next;
  };

  const onAction = useCallback((a: GestureAction) => {
    const trackpad = modeRef.current === 'trackpad';
    const at = (p: Pt, strict = false) => {
      if (trackpad) return cursor.current;
      const u = toUnit(p, strict);
      if (u) {
        cursor.current = u;
        setCursorShown(u);
      }
      return u;
    };
    switch (a.k) {
      case 'tap': {
        const u = at(a.at, true);
        if (u) send({ kind: 'mouse_click', x: r4(u.x), y: r4(u.y) });
        return;
      }
      case 'long':
      case 'twoTap': {
        const u = at(a.at, true);
        if (u) send({ kind: 'mouse_click', x: r4(u.x), y: r4(u.y), button: 'right' });
        navigator.vibrate?.(15);
        return;
      }
      case 'dragStart': {
        const u = at(a.at, true);
        dragging.current = u !== null;
        if (u) send({ kind: 'mouse_down', x: r4(u.x), y: r4(u.y) });
        return;
      }
      case 'dragMove': {
        if (!dragging.current) return;
        const u = trackpad ? moveCursor(a.dx, a.dy) : at(a.at);
        if (u) mover.current.push(u);
        return;
      }
      case 'dragEnd': {
        mover.current.cancel();
        if (!dragging.current) return;
        dragging.current = false;
        const u = trackpad ? cursor.current : at(a.at);
        if (u) {
          send({ kind: 'mouse_move', x: r4(u.x), y: r4(u.y) });
          send({ kind: 'mouse_up', x: r4(u.x), y: r4(u.y) });
        }
        return;
      }
      case 'hover':
        mover.current.push(moveCursor(a.dx, a.dy));
        return;
      case 'scroll':
        wheelAt.current = cursor.current;
        wheelAcc.current += scrollToWheel(a.dy);
        wheel.current.push(null);
        return;
      case 'zoom': {
        const lb = layoutBox();
        if (lb) setView((v) => zoomView(v, a.factor, { x: a.center.x - lb.left, y: a.center.y - lb.top }, lb));
        return;
      }
      case 'pan': {
        const lb = layoutBox();
        if (lb) setView((v) => panView(v, a.dx, a.dy, lb));
        return;
      }
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: reads refs only.
  }, []);

  const gestures = useMemo(() => createGestures((a) => onAction(a)), [onAction]);
  useEffect(() => gestures.setMode(mode), [gestures, mode]);
  useEffect(() => {
    if (!mayControl) gestures.cancel();
  }, [mayControl, gestures]);

  const active = mayControl && !host.isPhone;
  type ScreenEl = HTMLCanvasElement | HTMLVideoElement;
  const canvasProps = {
    onPointerDown: (e: React.PointerEvent<ScreenEl>) => {
      if (e.pointerType !== 'touch') return;
      setTouchSeen(true);
      if (!active) return;
      // A box left focused without the keyboard would make Android show it on this tap.
      if (!kb.current.wanted && document.activeElement === boxRef.current) boxRef.current?.blur();
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      gestures.down(e.pointerId, { x: e.clientX, y: e.clientY });
    },
    onPointerMove: (e: React.PointerEvent<ScreenEl>) => {
      if (e.pointerType !== 'touch' || !active) return;
      e.preventDefault();
      gestures.move(e.pointerId, { x: e.clientX, y: e.clientY });
    },
    onPointerUp: (e: React.PointerEvent<ScreenEl>) => {
      if (e.pointerType !== 'touch' || !active) return;
      e.preventDefault();
      gestures.up(e.pointerId, { x: e.clientX, y: e.clientY });
    },
    onPointerCancel: (e: React.PointerEvent<ScreenEl>) => {
      if (e.pointerType !== 'touch') return;
      gestures.cancel();
    },
    style: {
      // The page must not scroll or zoom under a finger that is controlling the computer.
      touchAction: active ? 'none' : undefined,
      transform: view.scale > 1 ? `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` : undefined,
      transformOrigin: '0 0',
    } as React.CSSProperties,
  };

  // ── Keys: the phone keyboard (hidden text box) and the extra-keys bar ──
  const [mods, setMods] = useState<Mods>(NO_MODS);
  const modsRef = useRef(mods);
  modsRef.current = mods;
  const typed = useRef(SENTINEL);
  const composing = useRef(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  const sendSteps = (value: string) => {
    const steps = diffTyped(typed.current, value);
    typed.current = value;
    if (!steps.length) return;
    let m = modsRef.current;
    for (const s of steps) {
      for (const ev of stepEvent(s, m)) send(ev);
      if (anyMod(m)) m = NO_MODS;
    }
    if (anyMod(modsRef.current)) setMods(NO_MODS);
  };
  const resetBox = () => {
    const b = boxRef.current;
    if (!b) return;
    b.value = SENTINEL;
    typed.current = SENTINEL;
    b.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };
  const boxProps = {
    ref: boxRef,
    defaultValue: SENTINEL,
    inputMode: 'none' as const,
    onBlur: () => boxBlur(),
    onInput: (e: React.FormEvent<HTMLTextAreaElement>) => {
      sendSteps(e.currentTarget.value);
      const v = e.currentTarget.value;
      if (!composing.current && (!v.startsWith(SENTINEL) || v.length > 48 || /[\r\n]/.test(v))) resetBox();
    },
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (e: React.CompositionEvent<HTMLTextAreaElement>) => {
      composing.current = false;
      sendSteps(e.currentTarget.value);
      resetBox();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // A hardware or Bluetooth keyboard on the phone: keys the box cannot show.
      const named: Record<string, string> = { Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
      const k = named[e.key];
      if (k) {
        e.preventDefault();
        pressKey({ press: k, combo: COMBO_NAME[k] ?? k });
      }
    },
  };

  const pressKey = (k: KeySpec) => {
    const m = modsRef.current;
    if (anyMod(m)) {
      send({ kind: 'key_combo', keys: comboKeys(m, k.combo) });
      setMods(NO_MODS);
    } else {
      send({ kind: 'key_press', key: k.press });
    }
  };
  const toggleMod = (name: keyof Mods) => {
    const m = modsRef.current;
    // Win tapped twice with nothing in between: the Start menu.
    if (name === 'win' && m.win && !m.ctrl && !m.alt && !m.shift) {
      send({ kind: 'key_combo', keys: ['Win'] });
      setMods(NO_MODS);
      return;
    }
    setMods({ ...m, [name]: !m[name] });
  };
  const combo = (keys: string[]) => send({ kind: 'key_combo', keys });

  // The phone keyboard shows only when the person taps "Keyboard". The hidden box keeps
  // inputmode="none" otherwise: Android shows the keyboard again on any tap while a text box has
  // focus, and closing the keyboard with Back leaves the box focused (owner, 2026-11-28: "the
  // keyboard keeps popping up by itself or when I tap anything").
  const kb = useRef({ wanted: false, shown: false, base: 0 });
  const closeKeyboard = useCallback(() => {
    kb.current.wanted = false;
    kb.current.shown = false;
    const b = boxRef.current;
    if (!b) return;
    b.inputMode = 'none';
    if (document.activeElement === b) b.blur();
  }, []);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const k = kb.current;
      if (!k.wanted) return;
      // The keyboard takes at least ~120 px; when the view grows back, it was closed (Back key).
      if (vv.height < k.base - 120) k.shown = true;
      else if (k.shown && vv.height > k.base - 60) closeKeyboard();
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [closeKeyboard]);

  const openKeyboard = () => {
    const b = boxRef.current;
    if (!b) return;
    if (kb.current.wanted && document.activeElement === b) {
      closeKeyboard();
      return;
    }
    resetBox();
    kb.current = { wanted: true, shown: false, base: window.visualViewport?.height ?? window.innerHeight };
    b.inputMode = 'text';
    b.focus({ preventScroll: true });
  };
  const boxBlur = () => {
    kb.current.wanted = false;
    kb.current.shown = false;
    if (boxRef.current) boxRef.current.inputMode = 'none';
  };

  return {
    /** A touch screen: the bar is shown. */
    touch: touchSeen,
    active,
    mode,
    setMode,
    view,
    resetView,
    cursor: cursorShown,
    canvasProps,
    boxProps,
    mods,
    toggleMod,
    pressKey,
    combo,
    openKeyboard,
  };
}

export type TouchControl = ReturnType<typeof useTouchControl>;

interface KeySpec {
  /** Name for key_press. */
  press: string;
  /** Name for key_combo (with Ctrl/Alt/Shift/Win held). */
  combo: string;
  label?: string;
}

const COMBO_NAME: Record<string, string> = { Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };

const KEYS: KeySpec[] = [
  { press: 'Escape', combo: 'Esc', label: 'Esc' },
  { press: 'Tab', combo: 'Tab', label: 'Tab' },
  { press: 'Delete', combo: 'Delete', label: 'Del' },
  { press: 'Backspace', combo: 'Backspace', label: '⌫' },
  { press: 'Enter', combo: 'Enter', label: '⏎' },
  { press: 'ArrowLeft', combo: 'Left', label: '←' },
  { press: 'ArrowUp', combo: 'Up', label: '↑' },
  { press: 'ArrowDown', combo: 'Down', label: '↓' },
  { press: 'ArrowRight', combo: 'Right', label: '→' },
  { press: 'Home', combo: 'Home', label: 'Home' },
  { press: 'End', combo: 'End', label: 'End' },
  { press: 'PageUp', combo: 'PageUp', label: 'PgUp' },
  { press: 'PageDown', combo: 'PageDown', label: 'PgDn' },
];
const FKEYS: KeySpec[] = Array.from({ length: 12 }, (_, i) => ({ press: `F${i + 1}`, combo: `F${i + 1}`, label: `F${i + 1}` }));

const TEXT = {
  en: {
    keyboard: 'Keyboard',
    keys: 'Keys',
    touch: 'Touch',
    trackpad: 'Touchpad',
    touchHint: 'Touch: tap = click, slide = drag, hold = right click, two fingers = scroll, pinch = zoom.',
    trackpadHint: 'Touchpad: slide = move the pointer, tap = click, tap then tap-and-slide = drag, hold or two-finger tap = right click, two fingers = scroll.',
    fit: 'Fit',
    fullscreen: 'Full screen',
    exitFullscreen: 'Exit full screen',
    hide: 'Hide the bar',
    show: 'Show the bar',
    typeHere: 'Typing goes to the computer',
    cad: 'Ctrl+Alt+Del',
    altTab: 'Alt+Tab',
    desktop: 'Desktop',
    copy: 'Copy',
    paste: 'Paste',
    undo: 'Undo',
  },
  ar: {
    keyboard: 'الكيبورد',
    keys: 'مفاتيح',
    touch: 'لمس',
    trackpad: 'تاتش باد',
    touchHint: 'لمس: دوسة = كليك، اسحب = سحب، دوسة طويلة = كليك يمين، صباعين = سكرول، قرّب وبعّد = تكبير.',
    trackpadHint: 'تاتش باد: حرّك صباعك = يتحرك الماوس، دوسة = كليك، دوسة وبعدها دوسة واسحب = سحب، دوسة طويلة أو دوسة بصباعين = كليك يمين، صباعين = سكرول.',
    fit: 'الحجم الأصلي',
    fullscreen: 'ملء الشاشة',
    exitFullscreen: 'خروج من ملء الشاشة',
    hide: 'إخفاء الشريط',
    show: 'إظهار الشريط',
    typeHere: 'الكتابة بتروح للكمبيوتر',
    cad: 'Ctrl+Alt+Del',
    altTab: 'Alt+Tab',
    desktop: 'سطح المكتب',
    copy: 'نسخ',
    paste: 'لصق',
    undo: 'تراجع',
  },
};

/** The floating bar on the remote picture (touch screens only). */
export function TouchBar({ tc, locale, onSas, fullscreen, onFullscreen }: { tc: TouchControl; locale: Locale; onSas?: () => void; fullscreen: boolean; onFullscreen: () => void }) {
  const tx = TEXT[locale === 'ar' ? 'ar' : 'en'];
  const [open, setOpen] = useState(true);
  const [keysOpen, setKeysOpen] = useState(false);
  const [fkeys, setFkeys] = useState(false);
  const [hint, setHint] = useState(false);
  const btn = 'flex h-9 shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] font-medium text-white/90 active:bg-white/25';
  const key = 'flex h-9 min-w-9 shrink-0 items-center justify-center rounded-[7px] bg-white/10 px-2 text-[13px] font-medium text-white active:bg-white/30';
  const mod = (on: boolean) => clsx(key, on && 'bg-accent text-white ring-1 ring-white/60');
  // Buttons never take focus away from the keyboard box (else the phone keyboard closes).
  const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

  return (
    <>
      <textarea
        {...tc.boxProps}
        aria-label={tx.typeHere}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="enter"
        className="pointer-events-none absolute bottom-0 left-0 h-px w-px resize-none opacity-0"
      />
      {tc.mode === 'trackpad' && tc.active && <TrackpadCursor tc={tc} />}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-1.5 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" dir="ltr">
        {hint && (
          <p className="pointer-events-auto max-w-md rounded-[8px] bg-black/75 px-3 py-2 text-[12px] leading-snug text-white" dir="auto" onClick={() => setHint(false)}>
            {tc.mode === 'trackpad' ? tx.trackpadHint : tx.touchHint}
          </p>
        )}
        {open && keysOpen && (
          <div className="pointer-events-auto flex max-w-full flex-col gap-1.5 rounded-[10px] bg-black/75 p-1.5 backdrop-blur-sm">
            <div className="flex max-w-full gap-1 overflow-x-auto">
              <button type="button" className={mod(tc.mods.ctrl)} onPointerDown={keep} onClick={() => tc.toggleMod('ctrl')}>
                Ctrl
              </button>
              <button type="button" className={mod(tc.mods.alt)} onPointerDown={keep} onClick={() => tc.toggleMod('alt')}>
                Alt
              </button>
              <button type="button" className={mod(tc.mods.shift)} onPointerDown={keep} onClick={() => tc.toggleMod('shift')}>
                Shift
              </button>
              <button type="button" className={mod(tc.mods.win)} onPointerDown={keep} onClick={() => tc.toggleMod('win')}>
                Win
              </button>
              {(fkeys ? FKEYS : KEYS).map((k) => (
                <button key={k.press} type="button" className={key} onPointerDown={keep} onClick={() => tc.pressKey(k)}>
                  {k.label}
                </button>
              ))}
              <button type="button" className={clsx(key, 'text-white/80')} onPointerDown={keep} onClick={() => setFkeys((v) => !v)}>
                {fkeys ? '←…' : 'F1…'}
              </button>
            </div>
            <div className="flex max-w-full gap-1 overflow-x-auto">
              <button type="button" className={key} onPointerDown={keep} onClick={() => tc.combo(['Ctrl', 'c'])}>
                {tx.copy}
              </button>
              <button type="button" className={key} onPointerDown={keep} onClick={() => tc.combo(['Ctrl', 'v'])}>
                {tx.paste}
              </button>
              <button type="button" className={key} onPointerDown={keep} onClick={() => tc.combo(['Ctrl', 'z'])}>
                {tx.undo}
              </button>
              <button type="button" className={key} onPointerDown={keep} onClick={() => tc.combo(['Alt', 'Tab'])}>
                {tx.altTab}
              </button>
              <button type="button" className={key} onPointerDown={keep} onClick={() => tc.combo(['Win', 'd'])}>
                {tx.desktop}
              </button>
              {onSas && (
                <button type="button" className={key} onPointerDown={keep} onClick={onSas}>
                  {tx.cad}
                </button>
              )}
            </div>
          </div>
        )}
        <div className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[12px] bg-black/75 p-1 shadow-lg backdrop-blur-sm">
          {open ? (
            <>
              <button type="button" className={btn} onPointerDown={keep} onClick={tc.openKeyboard} aria-label={tx.keyboard}>
                <Keyboard className="size-4" aria-hidden />
                <span className="max-[360px]:hidden">{tx.keyboard}</span>
              </button>
              <button type="button" className={clsx(btn, keysOpen && 'bg-white/20')} onPointerDown={keep} onClick={() => setKeysOpen((v) => !v)} aria-pressed={keysOpen}>
                Ctrl·Esc
              </button>
              <button
                type="button"
                className={btn}
                onPointerDown={keep}
                onClick={() => {
                  tc.setMode(tc.mode === 'touch' ? 'trackpad' : 'touch');
                  setHint(true);
                }}
                aria-label={tc.mode === 'touch' ? tx.touch : tx.trackpad}
              >
                {tc.mode === 'touch' ? <Hand className="size-4" aria-hidden /> : <MousePointer2 className="size-4" aria-hidden />}
                <span>{tc.mode === 'touch' ? tx.touch : tx.trackpad}</span>
              </button>
              {tc.view.scale > 1 && (
                <button type="button" className={btn} onPointerDown={keep} onClick={tc.resetView} aria-label={tx.fit}>
                  <ZoomOut className="size-4" aria-hidden />
                </button>
              )}
              <button type="button" className={btn} onPointerDown={keep} onClick={onFullscreen} aria-label={fullscreen ? tx.exitFullscreen : tx.fullscreen}>
                {fullscreen ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
              </button>
              <button type="button" className={btn} onPointerDown={keep} onClick={() => setOpen(false)} aria-label={tx.hide}>
                <ChevronDown className="size-4" aria-hidden />
              </button>
            </>
          ) : (
            <button type="button" className={btn} onPointerDown={keep} onClick={() => setOpen(true)} aria-label={tx.show}>
              <ChevronUp className="size-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** Touchpad mode: where the computer's pointer is, drawn on this screen (the stream may not show it yet). */
function TrackpadCursor({ tc }: { tc: TouchControl }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.parentElement;
    const video = el?.querySelector('video');
    const canvas = el?.querySelector('canvas');
    const media = video && video.videoWidth > 0 && !video.classList.contains('hidden') ? video : canvas;
    if (!el || !media) return;
    const b = mediaPictureBox(media);
    const p = el.getBoundingClientRect();
    setPos({ left: b.left - p.left + tc.cursor.x * b.width, top: b.top - p.top + tc.cursor.y * b.height });
  }, [tc.cursor, tc.view]);
  return (
    <div ref={ref} className="pointer-events-none absolute z-10" style={pos ? { left: pos.left, top: pos.top } : { display: 'none' }} aria-hidden>
      <svg width="18" height="24" viewBox="0 0 18 24" className="-translate-x-px -translate-y-px drop-shadow" aria-hidden="true">
        <path d="M1 1 L1 19 L6 14.5 L9.5 22 L12.5 20.6 L9 13.4 L16 13.4 Z" fill="white" stroke="black" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const r4 = (n: number) => Math.round(n * 10000) / 10000;

