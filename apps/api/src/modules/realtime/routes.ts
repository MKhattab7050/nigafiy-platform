import { type Response, Router } from 'express';
import { auth } from '../../common/http.ts';
import { onNotification, startListening, stopListening } from '../../infrastructure/pg-listen.ts';
import { REALTIME_CHANNEL } from './notify.ts';

/**
 * Real-time updates over Server-Sent Events.
 *
 * Writers call pg_notify() inside their transaction; PostgreSQL delivers on COMMIT to every API
 * instance's shared LISTEN connection (infrastructure/pg-listen.ts), which fans out to the browsers of that organization only.
 * The stream carries no data — only "topic X changed" hints — so the browser re-fetches through
 * the normal, authorized REST endpoints. Nothing sensitive can leak through the stream.
 */
export const realtimeRouter: Router = Router();

const subscribers = new Map<string, Set<Response>>();
const MAX_STREAMS_PER_ORG = 200;

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

let unsubscribe: (() => void) | null = null;

export async function startRealtime(): Promise<void> {
  unsubscribe ??= onNotification(REALTIME_CHANNEL, fanOut);
  await startListening();
}

export async function stopRealtime(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  for (const set of subscribers.values()) for (const res of set) res.end();
  subscribers.clear();
  await stopListening();
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
