import { type Response, Router } from 'express';
import pg from 'pg';
import { auth } from '../../common/http.ts';
import { env } from '../../config/env.ts';
import { logger } from '../../infrastructure/logger.ts';
import { REALTIME_CHANNEL } from './notify.ts';

/**
 * Real-time updates over Server-Sent Events.
 *
 * Writers call pg_notify() inside their transaction; PostgreSQL delivers on COMMIT to every API
 * instance's LISTEN connection, which fans out to the browsers of that organization only.
 * The stream carries no data — only "topic X changed" hints — so the browser re-fetches through
 * the normal, authorized REST endpoints. Nothing sensitive can leak through the stream.
 */
export const realtimeRouter: Router = Router();

const subscribers = new Map<string, Set<Response>>();
const MAX_STREAMS_PER_ORG = 200;
let listener: pg.Client | null = null;
let stopped = false;

function fanOut(payload: string): void {
  let message: { org?: string; topic?: string };
  try {
    message = JSON.parse(payload);
  } catch {
    return;
  }
  if (!message.org || !message.topic) return;
  for (const res of subscribers.get(message.org) ?? []) res.write(`event: change\ndata: ${JSON.stringify({ topic: message.topic })}\n\n`);
}

export async function startRealtime(): Promise<void> {
  if (stopped) return;
  const client = new pg.Client({ connectionString: env.DATABASE_URL, application_name: 'ld-realtime' });
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    if (listener === client) listener = null;
    void client.end().catch(() => undefined);
    if (!stopped) setTimeout(() => void startRealtime().catch(() => undefined), 2000).unref();
  };
  client.on('error', (err) => {
    logger.warn({ err }, 'realtime listener lost, reconnecting');
    retry();
  });
  client.on('notification', (n) => n.payload && fanOut(n.payload));
  try {
    await client.connect();
    if (stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    await client.query(`LISTEN ${REALTIME_CHANNEL}`);
    if (stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    listener = client;
  } catch (err) {
    logger.warn({ err }, 'realtime listener failed to start, retrying');
    await client.end().catch(() => undefined);
    retry();
  }
}

export async function stopRealtime(): Promise<void> {
  stopped = true;
  for (const set of subscribers.values()) for (const res of set) res.end();
  subscribers.clear();
  const current = listener;
  listener = null;
  await current?.end().catch(() => undefined);
}

realtimeRouter.get('/stream', (req, res) => {
  const { organizationId } = auth(req); // session already verified by requireSession
  const set = subscribers.get(organizationId) ?? new Set<Response>();
  if (set.size >= MAX_STREAMS_PER_ORG) {
    res.status(429).json({ error: { code: 'too_many_streams', message: 'Too many open live connections' } });
    return;
  }
  subscribers.set(organizationId, set);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\nevent: ready\ndata: {}\n\n`);
  set.add(res);
  const keepAlive = setInterval(() => res.write(`: keep-alive\n\n`), 25_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    set.delete(res);
    if (set.size === 0) subscribers.delete(organizationId);
  });
});
