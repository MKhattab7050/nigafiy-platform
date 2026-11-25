import { WebSocket } from 'ws';

/*
 * Limits shared by the WebSocket hubs (remote desktop stream, remote shell), EXT-2:
 *   - message size: each hub's WebSocketServer has a maxPayload per kind of client (the `ws`
 *     library closes the socket with 1009 above it, before the message is buffered whole);
 *   - message rate: a per-socket window (`MessageRate`): above `soft` messages in a second the
 *     extra ones are dropped, above `hard` the socket is closed with 1008;
 *   - connection count: sockets still being authenticated per address (`UpgradeGate`) and open
 *     sockets per user and per session (checked by the hubs);
 *   - idle sockets: a ping every `pingMs`; a socket that answered none of the last two is
 *     terminated (`heartbeat`), so a dead TCP connection does not hold a viewer slot or a shell.
 */

/** Close code for a client that broke a limit (RFC 6455 "policy violation"). */
export const CLOSE_POLICY = 1008;

export interface WsLimits {
  /** Messages per second a socket may send; above this they are dropped. */
  softPerSecond: number;
  /** Messages per second after which the socket is closed with 1008. */
  hardPerSecond: number;
  /** Messages a socket may have waiting to be handled (audits are written in order). */
  maxQueued: number;
  /** Ping interval; two unanswered pings end the socket. */
  pingMs: number;
  /** Upgrades being authenticated at once from one address. */
  maxPendingPerAddress: number;
  /** Open operator sockets per signed-in user (all endpoints, this instance). */
  maxPerUser: number;
  /** Open operator sockets in one session (viewers of one remote desktop, tabs of one shell). */
  maxPerSession: number;
}

export const DEFAULT_WS_LIMITS: WsLimits = {
  // Pointer movement runs at the display rate (60-144 Hz) plus keys, wheel and acks.
  softPerSecond: 300,
  hardPerSecond: 1500,
  maxQueued: 512,
  pingMs: 30_000,
  maxPendingPerAddress: 16,
  maxPerUser: 12,
  maxPerSession: 16,
};

/** Fixed one-second window counter for one socket. */
export class MessageRate {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly soft: number,
    private readonly hard: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 'ok' to handle the message, 'drop' to ignore it, 'close' to end the socket. */
  take(): 'ok' | 'drop' | 'close' {
    const t = this.now();
    if (t - this.windowStart >= 1000) {
      this.windowStart = t;
      this.count = 0;
    }
    this.count++;
    if (this.count > this.hard) return 'close';
    if (this.count > this.soft) return 'drop';
    return 'ok';
  }
}

/** Pings the socket every `ms`; terminates it when the previous ping got no pong. Returns a stop function. */
export function heartbeat(ws: WebSocket, ms: number): () => void {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  // Any message from the client also proves it is there.
  ws.on('message', () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }, ms);
  timer.unref();
  const stop = () => clearInterval(timer);
  ws.once('close', stop);
  return stop;
}

/** Counts sockets per key; `acquire` returns a release function, or null when the key is at `max`. */
export class SocketCounter {
  private readonly counts = new Map<string, number>();

  acquire(key: string, max: number): (() => void) | null {
    const n = this.counts.get(key) ?? 0;
    if (n >= max) return null;
    this.counts.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(key) ?? 1) - 1;
      if (left <= 0) this.counts.delete(key);
      else this.counts.set(key, left);
    };
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
