import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type GestureAction, LONG_PRESS_MS, MAX_ZOOM, clampView, createGestures, followPoint, zoomView } from './touch-gestures.ts';

function fakeClock() {
  let t = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let next = 1;
  return {
    now: () => t,
    set: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clear: (id: unknown) => {
      timers = timers.filter((x) => x.id !== id);
    },
    advance(ms: number) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers = timers.filter((x) => x.at > t);
      for (const d of due) d.fn();
    },
  };
}

function setup(mode: 'touch' | 'trackpad' = 'touch') {
  const clock = fakeClock();
  const out: GestureAction[] = [];
  const g = createGestures((a) => out.push(a), mode, clock);
  return { clock, out, g, kinds: () => out.map((a) => a.k) };
}

describe('touch gestures, touch mode', () => {
  it('a quick tap is a click where the finger was', () => {
    const { g, out, clock } = setup();
    g.down(1, { x: 100, y: 50 });
    clock.advance(80);
    g.move(1, { x: 103, y: 52 }); // a little jitter is still a tap
    g.up(1, { x: 103, y: 52 });
    assert.deepEqual(out, [{ k: 'tap', at: { x: 103, y: 52 } }]);
  });

  it('a slide drags from where the finger went down', () => {
    const { g, out, kinds } = setup();
    g.down(1, { x: 10, y: 10 });
    g.move(1, { x: 40, y: 10 });
    g.move(1, { x: 60, y: 20 });
    g.up(1, { x: 60, y: 20 });
    assert.deepEqual(kinds(), ['dragStart', 'dragMove', 'dragMove', 'dragEnd']);
    assert.deepEqual(out[0], { k: 'dragStart', at: { x: 10, y: 10 } });
  });

  it('holding still is a right click, and nothing more for that touch', () => {
    const { g, kinds, clock } = setup();
    g.down(1, { x: 10, y: 10 });
    clock.advance(LONG_PRESS_MS + 1);
    g.move(1, { x: 80, y: 80 });
    g.up(1, { x: 80, y: 80 });
    assert.deepEqual(kinds(), ['long']);
  });

  it('two fingers sliding together scroll', () => {
    const { g, out, kinds } = setup();
    g.down(1, { x: 100, y: 100 });
    g.down(2, { x: 160, y: 100 });
    g.move(1, { x: 100, y: 130 });
    g.move(2, { x: 160, y: 130 });
    g.up(1, { x: 100, y: 130 });
    g.up(2, { x: 160, y: 130 });
    assert.ok(kinds().every((k) => k === 'scroll'));
    const total = out.reduce((n, a) => n + (a.k === 'scroll' ? a.dy : 0), 0);
    assert.equal(total, 30);
  });

  it('two fingers spreading zoom the picture instead', () => {
    const { g, kinds } = setup();
    g.down(1, { x: 100, y: 100 });
    g.down(2, { x: 140, y: 100 });
    g.move(1, { x: 60, y: 100 });
    g.move(2, { x: 180, y: 100 });
    assert.ok(kinds().includes('zoom'));
    assert.ok(!kinds().includes('scroll'));
  });

  it('a quick two-finger tap is a right click; a slow one is nothing', () => {
    const a = setup();
    a.g.down(1, { x: 100, y: 100 });
    a.g.down(2, { x: 140, y: 100 });
    a.clock.advance(120);
    a.g.up(1, { x: 100, y: 100 });
    a.g.up(2, { x: 140, y: 100 });
    assert.deepEqual(a.out, [{ k: 'twoTap', at: { x: 120, y: 100 } }]);

    const b = setup();
    b.g.down(1, { x: 100, y: 100 });
    b.g.down(2, { x: 140, y: 100 });
    b.clock.advance(900);
    b.g.up(1, { x: 100, y: 100 });
    b.g.up(2, { x: 140, y: 100 });
    assert.deepEqual(b.out, []);
  });

  it('a second finger during a drag ends the drag (the button is never left down)', () => {
    const { g, kinds } = setup();
    g.down(1, { x: 10, y: 10 });
    g.move(1, { x: 50, y: 10 });
    g.down(2, { x: 200, y: 200 });
    g.up(1, { x: 50, y: 10 });
    g.up(2, { x: 200, y: 200 });
    assert.deepEqual(kinds(), ['dragStart', 'dragMove', 'dragEnd']);
  });

  it('a double tap clicks twice on the same spot, even when the finger lands a little apart', () => {
    const { g, out, clock } = setup();
    g.down(1, { x: 100, y: 50 });
    g.up(1, { x: 100, y: 50 });
    clock.advance(150);
    g.down(2, { x: 112, y: 58 });
    g.move(2, { x: 125, y: 60 }); // a wobble a single tap would call a slide
    g.up(2, { x: 125, y: 60 });
    assert.deepEqual(out, [
      { k: 'tap', at: { x: 100, y: 50 } },
      { k: 'tap', at: { x: 100, y: 50 } },
    ]);
    // A third quick tap is a new first click, where that finger is.
    clock.advance(100);
    g.down(3, { x: 130, y: 70 });
    g.up(3, { x: 130, y: 70 });
    assert.deepEqual(out[2], { k: 'tap', at: { x: 130, y: 70 } });
  });

  it('two taps far apart or slow are two separate clicks', () => {
    const { g, out, clock } = setup();
    g.down(1, { x: 100, y: 50 });
    g.up(1, { x: 100, y: 50 });
    clock.advance(600);
    g.down(2, { x: 104, y: 50 });
    g.up(2, { x: 104, y: 50 });
    clock.advance(100);
    g.down(3, { x: 300, y: 50 });
    g.up(3, { x: 300, y: 50 });
    assert.deepEqual(out.map((a) => (a.k === 'tap' ? a.at.x : -1)), [100, 104, 300]);
  });

  it('a cancelled touch releases the button', () => {
    const { g, kinds } = setup();
    g.down(1, { x: 10, y: 10 });
    g.move(1, { x: 50, y: 10 });
    g.cancel();
    assert.deepEqual(kinds(), ['dragStart', 'dragMove', 'dragEnd']);
  });
});

describe('touch gestures, touchpad mode', () => {
  it('a slide moves the pointer, with no button held', () => {
    const { g, out, kinds } = setup('trackpad');
    g.down(1, { x: 10, y: 10 });
    g.move(1, { x: 30, y: 10 });
    g.move(1, { x: 35, y: 12 });
    g.up(1, { x: 35, y: 12 });
    assert.deepEqual(kinds(), ['hover', 'hover']);
    assert.deepEqual(out[1], { k: 'hover', at: { x: 35, y: 12 }, dx: 5, dy: 2 });
  });

  it('tap, then tap-and-slide drags', () => {
    const { g, kinds, clock } = setup('trackpad');
    g.down(1, { x: 10, y: 10 });
    g.up(1, { x: 10, y: 10 });
    clock.advance(150);
    g.down(2, { x: 12, y: 11 });
    g.move(2, { x: 60, y: 11 });
    g.up(2, { x: 60, y: 11 });
    assert.deepEqual(kinds(), ['tap', 'dragStart', 'dragMove', 'dragEnd']);
  });

  it('two taps make two clicks (a double click), not a drag', () => {
    const { g, kinds, clock } = setup('trackpad');
    g.down(1, { x: 10, y: 10 });
    g.up(1, { x: 10, y: 10 });
    clock.advance(120);
    g.down(2, { x: 10, y: 10 });
    g.up(2, { x: 10, y: 10 });
    assert.deepEqual(kinds(), ['tap', 'tap']);
  });

  it('a slide long after a tap only moves the pointer', () => {
    const { g, kinds, clock } = setup('trackpad');
    g.down(1, { x: 10, y: 10 });
    g.up(1, { x: 10, y: 10 });
    clock.advance(1_000);
    g.down(2, { x: 10, y: 10 });
    g.move(2, { x: 60, y: 10 });
    assert.deepEqual(kinds(), ['tap', 'hover']);
  });
});

describe('local zoom', () => {
  const box = { width: 400, height: 200 };

  it('zooms around the fingers and never past the limit', () => {
    const v = zoomView({ scale: 1, tx: 0, ty: 0 }, 2, { x: 200, y: 100 }, box);
    assert.deepEqual(v, { scale: 2, tx: -200, ty: -100 });
    assert.equal(zoomView(v, 100, { x: 0, y: 0 }, box).scale, MAX_ZOOM);
  });

  it('never leaves a gap at the edges, and back at 1x sits at the origin', () => {
    assert.deepEqual(clampView({ scale: 2, tx: 50, ty: -500 }, box), { scale: 2, tx: 0, ty: -200 });
    assert.deepEqual(zoomView({ scale: 2, tx: -100, ty: -50 }, 0.1, { x: 10, y: 10 }, box), { scale: 1, tx: 0, ty: 0 });
  });

  it('follows the touchpad pointer to the edge', () => {
    const v = followPoint({ scale: 2, tx: 0, ty: 0 }, { x: 300, y: 50 }, box);
    // 300 * 2 = 600 on screen; it comes back inside 400 - 40.
    assert.equal(v.tx + 300 * 2, 360);
    // At the picture's own edge the view stops at the edge (no gap).
    assert.equal(followPoint({ scale: 2, tx: 0, ty: 0 }, { x: 395, y: 50 }, box).tx, -400);
  });
});
