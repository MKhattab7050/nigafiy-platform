/**
 * Touch gestures on the remote screen (a phone or tablet controlling a computer). The browser only
 * turns a tap into mouse events, so before this a phone could click and nothing else: no drag, no
 * scroll, no right click (owner, 2026-11-27). This turns raw touch points into the operator's
 * intent; use-touch-control.ts turns the intent into mouse and wheel events for the agent.
 *
 * Two modes, like other remote desktop apps on a phone:
 * - `touch`: the computer's pointer goes where the finger is. Tap = click there, slide = drag
 *   (select text, move a window), hold = right click.
 * - `trackpad`: the screen is a laptop touchpad. Slide = move the pointer, tap = click where the
 *   pointer is, tap then tap-and-slide = drag, hold = right click.
 * In both: two fingers slide = scroll, two-finger tap = right click, pinch = zoom the picture here
 * (nothing is sent; the picture is magnified on this screen only).
 *
 * Points are screen pixels. Pure (time and timers come in), so it is unit tested.
 */

export type TouchMode = 'touch' | 'trackpad';

export interface Pt {
  x: number;
  y: number;
}

export type GestureAction =
  | { k: 'tap'; at: Pt }
  | { k: 'long'; at: Pt }
  | { k: 'dragStart'; at: Pt }
  | { k: 'dragMove'; at: Pt; dx: number; dy: number }
  | { k: 'dragEnd'; at: Pt }
  /** Trackpad: one finger sliding with no button held. */
  | { k: 'hover'; at: Pt; dx: number; dy: number }
  /** Two fingers sliding up or down; dy > 0: the fingers moved down. */
  | { k: 'scroll'; dy: number }
  | { k: 'zoom'; factor: number; center: Pt }
  | { k: 'pan'; dx: number; dy: number }
  | { k: 'twoTap'; at: Pt };

export interface GestureClock {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(t: unknown): void;
}

/** A finger has to move this far (px) before a touch counts as a slide. */
export const SLOP = 9;
export const LONG_PRESS_MS = 550;
/** Trackpad: the second touch of "tap, then tap-and-slide" must start this soon after the tap. */
export const DOUBLE_TAP_MS = 320;
/**
 * Touch mode: a tap this soon after a tap, and this close, is the second click of a double click.
 * It lands exactly where the first one did: Windows only counts two clicks as a double click when
 * the pointer moved less than a few pixels, and a finger never comes down twice on the same phone
 * pixel (owner, 2026-11-27: "double tap shakes the mouse and opens nothing").
 */
export const DOUBLE_CLICK_MS = 450;
export const DOUBLE_CLICK_PX = 40;
/** The second touch of a double tap may wobble this much (px) and still be a tap, not a drag. */
const DOUBLE_SLOP = 24;
/** Two fingers lifted this soon without moving: a two-finger tap. */
export const TWO_TAP_MS = 350;
/** Two fingers whose distance changes this much (px) are pinching, not scrolling. */
const PINCH_PX = 26;

type State =
  | { s: 'idle' }
  | { s: 'pending'; id: number; start: Pt; last: Pt; armed: boolean; second: Pt | null }
  | { s: 'drag'; id: number; last: Pt }
  | { s: 'hover'; id: number; last: Pt }
  | { s: 'two'; a: number; b: number; pts: Map<number, Pt>; startMid: Pt; startDist: number; lastMid: Pt; lastDist: number; at: number; sub: null | 'scroll' | 'pinch' }
  /** The gesture is over (a long press fired, a second finger came during a slide…): wait for all fingers up. */
  | { s: 'spent' };

export interface Gestures {
  down(id: number, p: Pt): void;
  move(id: number, p: Pt): void;
  up(id: number, p: Pt): void;
  cancel(): void;
  setMode(m: TouchMode): void;
}

export function createGestures(onAction: (a: GestureAction) => void, initialMode: TouchMode = 'touch', clock: GestureClock = defaultClock): Gestures {
  let mode = initialMode;
  let st: State = { s: 'idle' };
  const fingers = new Set<number>();
  let longTimer: unknown = null;
  let lastTap: { at: number; p: Pt } | null = null;

  const stopLong = () => {
    if (longTimer !== null) clock.clear(longTimer);
    longTimer = null;
  };

  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

  function down(id: number, p: Pt) {
    fingers.add(id);
    if (st.s === 'idle' && fingers.size === 1) {
      const armed = mode === 'trackpad' && lastTap !== null && clock.now() - lastTap.at <= DOUBLE_TAP_MS && dist(lastTap.p, p) < 60;
      const second =
        mode === 'touch' && lastTap !== null && clock.now() - lastTap.at <= DOUBLE_CLICK_MS && dist(lastTap.p, p) < DOUBLE_CLICK_PX ? lastTap.p : null;
      st = { s: 'pending', id, start: p, last: p, armed, second };
      stopLong();
      longTimer = clock.set(() => {
        longTimer = null;
        if (st.s === 'pending' && st.id === id) {
          onAction({ k: 'long', at: st.last });
          st = { s: 'spent' };
        }
      }, LONG_PRESS_MS);
      return;
    }
    if (st.s === 'pending' && fingers.size === 2) {
      stopLong();
      const first = st.last;
      const pts = new Map<number, Pt>([
        [st.id, first],
        [id, p],
      ]);
      const m = mid(first, p);
      const d = dist(first, p);
      st = { s: 'two', a: st.id, b: id, pts, startMid: m, startDist: d, lastMid: m, lastDist: d, at: clock.now(), sub: null };
      return;
    }
    // A third finger, or a second one during a slide: this gesture is over.
    if (st.s === 'drag') onAction({ k: 'dragEnd', at: st.last });
    stopLong();
    st = { s: 'spent' };
  }

  function move(id: number, p: Pt) {
    if (st.s === 'pending' && st.id === id) {
      if (dist(st.start, p) < (st.second ? DOUBLE_SLOP : SLOP)) {
        st.last = p;
        return;
      }
      stopLong();
      const from = st.start;
      if (mode === 'touch' || st.armed) {
        onAction({ k: 'dragStart', at: from });
        onAction({ k: 'dragMove', at: p, dx: p.x - from.x, dy: p.y - from.y });
        st = { s: 'drag', id, last: p };
      } else {
        onAction({ k: 'hover', at: p, dx: p.x - from.x, dy: p.y - from.y });
        st = { s: 'hover', id, last: p };
      }
      return;
    }
    if ((st.s === 'drag' || st.s === 'hover') && st.id === id) {
      const dx = p.x - st.last.x;
      const dy = p.y - st.last.y;
      if (dx === 0 && dy === 0) return;
      onAction(st.s === 'drag' ? { k: 'dragMove', at: p, dx, dy } : { k: 'hover', at: p, dx, dy });
      st.last = p;
      return;
    }
    if (st.s === 'two' && st.pts.has(id)) {
      st.pts.set(id, p);
      const a = st.pts.get(st.a)!;
      const b = st.pts.get(st.b)!;
      const m = mid(a, b);
      const d = dist(a, b);
      if (st.sub === null) {
        if (Math.abs(d - st.startDist) > PINCH_PX) st.sub = 'pinch';
        else if (dist(m, st.startMid) > SLOP) st.sub = 'scroll';
        else return;
      }
      if (st.sub === 'pinch') {
        if (st.lastDist > 0 && d > 0) onAction({ k: 'zoom', factor: d / st.lastDist, center: m });
        onAction({ k: 'pan', dx: m.x - st.lastMid.x, dy: m.y - st.lastMid.y });
      } else {
        const dy = m.y - st.lastMid.y;
        if (dy !== 0) onAction({ k: 'scroll', dy });
      }
      st.lastMid = m;
      st.lastDist = d;
    }
  }

  function up(id: number, p: Pt) {
    fingers.delete(id);
    if (st.s === 'pending' && st.id === id) {
      stopLong();
      onAction({ k: 'tap', at: st.second ?? st.last });
      // The second tap of a double tap does not arm a drag, or another double click, for a third.
      lastTap = st.armed || st.second ? null : { at: clock.now(), p: st.last };
      st = { s: 'idle' };
    } else if (st.s === 'drag' && st.id === id) {
      onAction({ k: 'dragEnd', at: p });
      st = fingers.size ? { s: 'spent' } : { s: 'idle' };
      lastTap = null;
    } else if (st.s === 'hover' && st.id === id) {
      st = fingers.size ? { s: 'spent' } : { s: 'idle' };
      lastTap = null;
    } else if (st.s === 'two' && st.pts.has(id)) {
      if (st.sub === null && clock.now() - st.at <= TWO_TAP_MS) onAction({ k: 'twoTap', at: st.startMid });
      st = { s: 'spent' };
      lastTap = null;
    }
    if (fingers.size === 0 && st.s === 'spent') st = { s: 'idle' };
  }

  function cancel() {
    stopLong();
    if (st.s === 'drag') onAction({ k: 'dragEnd', at: st.last });
    fingers.clear();
    st = { s: 'idle' };
    lastTap = null;
  }

  return {
    down,
    move,
    up,
    cancel,
    setMode(m) {
      if (m === mode) return;
      cancel();
      mode = m;
    },
  };
}

const defaultClock: GestureClock = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/** Trackpad pointer speed: slow moves stay precise, quick flicks cross the screen. */
export function trackpadGain(pxPerEvent: number): number {
  const v = Math.abs(pxPerEvent);
  if (v < 3) return 1;
  if (v > 25) return 2.6;
  return 1 + ((v - 3) / 22) * 1.6;
}

/**
 * Two-finger scrolling to wheel units (120 = one notch). Fingers moving down drag the page down,
 * which shows what is above: a wheel turned up (positive on Windows).
 */
export function scrollToWheel(dyPx: number): number {
  return Math.round(dyPx * 4);
}

/** The local zoom: the picture magnified on this screen, kept covering the viewport. */
export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export const MAX_ZOOM = 4;

export function zoomView(v: View, factor: number, center: Pt, box: { width: number; height: number }): View {
  const scale = Math.max(1, Math.min(MAX_ZOOM, v.scale * factor));
  const k = scale / v.scale;
  // Keep the point under the fingers where it is.
  return clampView({ scale, tx: center.x - (center.x - v.tx) * k, ty: center.y - (center.y - v.ty) * k }, box);
}

export function panView(v: View, dx: number, dy: number, box: { width: number; height: number }): View {
  return clampView({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy }, box);
}

/** tx/ty are relative to the unzoomed box's top-left; the magnified picture never leaves a gap. */
export function clampView(v: View, box: { width: number; height: number }): View {
  if (v.scale <= 1) return { scale: 1, tx: 0, ty: 0 };
  const minX = box.width - box.width * v.scale;
  const minY = box.height - box.height * v.scale;
  return { scale: v.scale, tx: Math.min(0, Math.max(minX, v.tx)), ty: Math.min(0, Math.max(minY, v.ty)) };
}

/** Pans so a point of the unzoomed box (the trackpad pointer) stays on screen, with a margin. */
export function followPoint(v: View, p: Pt, box: { width: number; height: number }, margin = 40): View {
  if (v.scale <= 1) return v;
  const sx = v.tx + p.x * v.scale;
  const sy = v.ty + p.y * v.scale;
  let { tx, ty } = v;
  if (sx < margin) tx += margin - sx;
  else if (sx > box.width - margin) tx -= sx - (box.width - margin);
  if (sy < margin) ty += margin - sy;
  else if (sy > box.height - margin) ty -= sy - (box.height - margin);
  return clampView({ scale: v.scale, tx, ty }, box);
}
