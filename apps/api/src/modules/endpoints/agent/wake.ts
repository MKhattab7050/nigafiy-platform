import { EventEmitter } from 'node:events';

// Agent long-poll wake-up. A trigger on endpoint_commands (migration 033) sends
// pg_notify('ld_agent_wake', <endpoint id>) for every new pending command; the endpoints module's
// lifecycle turns it into an `wake:<endpoint id>` event here, on every API instance.

/** pg_notify channel raised by the endpoint_commands insert trigger. */
export const AGENT_WAKE_CHANNEL = 'ld_agent_wake';
/** Longest wait an agent may ask for (it re-polls right after). */
export const MAX_POLL_WAIT_MS = 25_000;
/**
 * Even without a notification (listener reconnecting, notification lost) a waiting poll looks at
 * the queue again this often, so a command is never stuck for the whole wait.
 */
export const POLL_RECHECK_MS = 2_000;

const wakeEvents = new EventEmitter();
wakeEvents.setMaxListeners(0);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Handler for AGENT_WAKE_CHANNEL notifications. */
export function onAgentWakeNotification(payload: string): void {
  if (UUID.test(payload)) wakeEvents.emit(`wake:${payload.toLowerCase()}`);
}

/** Wakes this instance's waiting polls of one endpoint (tests; production uses the trigger). */
export function wakeAgent(endpointId: string): void {
  wakeEvents.emit(`wake:${endpointId.toLowerCase()}`);
}

/** Number of polls currently waiting on this instance (tests). */
export function waitingPollCount(): number {
  return wakeEvents.eventNames().reduce((n, e) => n + wakeEvents.listenerCount(e), 0);
}

/** `?wait_ms=` of an agent poll: 0 (answer at once, the old behaviour) up to MAX_POLL_WAIT_MS. */
export function parsePollWaitMs(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? '0'), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_POLL_WAIT_MS, n);
}

/**
 * A subscription that is armed before the queue is read, so a command inserted between the read and
 * the wait is not missed. `next(ms)` resolves on a wake-up, after `ms`, or when `signal` aborts.
 */
export function armWake(endpointId: string, signal: AbortSignal) {
  const event = `wake:${endpointId.toLowerCase()}`;
  let woken = false;
  let resolveCurrent: (() => void) | null = null;
  const onWake = () => {
    woken = true;
    resolveCurrent?.();
  };
  wakeEvents.on(event, onWake);
  const onAbort = () => resolveCurrent?.();
  signal.addEventListener('abort', onAbort);
  return {
    /** Waits for a wake-up (or the timeout / abort). Returns true when woken. */
    next(ms: number): Promise<boolean> {
      if (woken || signal.aborted) {
        const was = woken;
        woken = false;
        return Promise.resolve(was);
      }
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolveCurrent = null;
          resolve(false);
        }, ms);
        resolveCurrent = () => {
          clearTimeout(timer);
          resolveCurrent = null;
          const was = woken;
          woken = false;
          resolve(was);
        };
      });
    },
    close(): void {
      wakeEvents.removeListener(event, onWake);
      signal.removeEventListener('abort', onAbort);
      resolveCurrent?.();
    },
  };
}
