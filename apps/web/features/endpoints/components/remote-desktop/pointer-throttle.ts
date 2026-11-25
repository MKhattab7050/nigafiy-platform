/**
 * Pointer moves for the remote screen: at most one every `intervalMs`, and the last one is always
 * sent (trailing edge). Dropping moves that come too soon without a trailing send left the remote
 * pointer short of where the operator's pointer came to rest (measured with the real agent and a
 * real browser on 127.0.0.1, 2026-11-25).
 */
export interface PointerThrottle<T> {
  push(value: T): void;
  cancel(): void;
}

export function pointerThrottle<T>(
  send: (value: T) => void,
  intervalMs = 50,
  clock: { now: () => number; set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    now: () => performance.now(),
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): PointerThrottle<T> {
  let last = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  const fire = (value: T) => {
    timer = null;
    last = clock.now();
    send(value);
  };
  return {
    push(value) {
      if (timer !== null) clock.clear(timer);
      timer = null;
      const wait = intervalMs - (clock.now() - last);
      if (wait <= 0) fire(value);
      else timer = clock.set(() => fire(value), wait);
    },
    cancel() {
      if (timer !== null) clock.clear(timer);
      timer = null;
    },
  };
}
