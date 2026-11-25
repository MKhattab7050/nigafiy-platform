// Unit tests of the remote pointer throttle. Run with `pnpm --filter @nigafiy/web test:unit`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pointerThrottle } from './pointer-throttle.ts';

function fakeClock() {
  let t = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    set: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clear: (id: unknown) => void timers.delete(id as number),
    advance(ms: number) {
      t += ms;
      for (const [id, x] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (x.at <= t) {
          timers.delete(id);
          x.fn();
        }
      }
    },
  };
}

describe('pointerThrottle', () => {
  it('sends the first move at once and the last move of a fast burst after the interval', () => {
    const clock = fakeClock();
    const sent: number[] = [];
    const th = pointerThrottle<number>((v) => sent.push(v), 50, clock);
    th.push(1);
    clock.advance(10);
    th.push(2);
    clock.advance(10);
    th.push(3);
    assert.deepEqual(sent, [1]);
    clock.advance(29);
    assert.deepEqual(sent, [1]);
    clock.advance(1);
    // The resting position (3) arrives; 2 was superseded.
    assert.deepEqual(sent, [1, 3]);
    clock.advance(500);
    assert.deepEqual(sent, [1, 3]);
  });

  it('never sends more than one move per interval, and slow moves go at once', () => {
    const clock = fakeClock();
    const at: number[] = [];
    const th = pointerThrottle<number>(() => at.push(clock.now()), 50, clock);
    for (let i = 0; i < 40; i++) {
      th.push(i);
      clock.advance(7);
    }
    clock.advance(100);
    for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= 50, `gap ${at[i]! - at[i - 1]!}`);
    const before = at.length;
    th.push(99);
    assert.equal(at.length, before + 1);
  });

  it('cancel drops a pending move', () => {
    const clock = fakeClock();
    const sent: number[] = [];
    const th = pointerThrottle<number>((v) => sent.push(v), 50, clock);
    th.push(1);
    th.push(2);
    th.cancel();
    clock.advance(100);
    assert.deepEqual(sent, [1]);
  });
});
