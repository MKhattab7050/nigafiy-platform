import pg from 'pg';
import { env } from '../config/env.ts';
import { logger } from './logger.ts';

/**
 * One shared PostgreSQL LISTEN connection per API process.
 *
 * Writers call `pg_notify(channel, payload)` inside their transaction; PostgreSQL delivers it on
 * COMMIT to every API instance listening on that channel, this one included. Modules subscribe
 * with `onNotification()` and call `startListening()` from their lifecycle start; the connection
 * reconnects by itself (and re-subscribes every channel) when it drops.
 */
type Handler = (payload: string) => void;

const handlers = new Map<string, Set<Handler>>();
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;
let stopped = false;
let retryTimer: NodeJS.Timeout | null = null;

const CHANNEL = /^[a-z][a-z0-9_]{0,62}$/;

function assertChannel(channel: string): void {
  // LISTEN takes an identifier, not a parameter: only fixed, code-defined names are allowed.
  if (!CHANNEL.test(channel)) throw new Error(`invalid notification channel name: ${channel}`);
}

/** Subscribe to a channel. Returns an unsubscribe function. */
export function onNotification(channel: string, handler: Handler): () => void {
  assertChannel(channel);
  let set = handlers.get(channel);
  if (!set) {
    set = new Set();
    handlers.set(channel, set);
    if (client) void client.query(`LISTEN ${channel}`).catch((err) => logger.warn({ err, channel }, 'LISTEN failed'));
  }
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

function dispatch(n: pg.Notification): void {
  for (const handler of handlers.get(n.channel) ?? []) {
    try {
      handler(n.payload ?? '');
    } catch (err) {
      logger.error({ err, channel: n.channel }, 'notification handler failed');
    }
  }
}

function scheduleReconnect(): void {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void startListening();
  }, 2000);
  retryTimer.unref();
}

async function connect(): Promise<void> {
  const c = new pg.Client({ connectionString: env.DATABASE_URL, application_name: 'ld-listen' });
  let lost = false;
  const onLost = (err?: Error) => {
    if (lost) return;
    lost = true;
    if (client === c) client = null;
    void c.end().catch(() => undefined);
    if (!stopped) {
      logger.warn({ err }, 'notification listener lost, reconnecting');
      scheduleReconnect();
    }
  };
  c.on('error', onLost);
  c.on('end', () => onLost());
  c.on('notification', dispatch);
  try {
    await c.connect();
    for (const channel of handlers.keys()) await c.query(`LISTEN ${channel}`);
    if (stopped) {
      lost = true;
      await c.end().catch(() => undefined);
      return;
    }
    client = c;
  } catch (err) {
    logger.warn({ err }, 'notification listener failed to start, retrying');
    onLost(err as Error);
  }
}

/** Start (or keep) the shared listener. Safe to call from several modules. */
export async function startListening(): Promise<void> {
  stopped = false;
  if (client) return;
  connecting ??= connect().finally(() => {
    connecting = null;
  });
  await connecting;
}

/** True while the listener connection is up (used by tests and the self-check). */
export function isListening(): boolean {
  return client !== null;
}

/** Stop the shared listener (process shutdown). */
export async function stopListening(): Promise<void> {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  await connecting?.catch(() => undefined);
  const current = client;
  client = null;
  await current?.end().catch(() => undefined);
}
