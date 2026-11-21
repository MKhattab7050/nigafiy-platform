import type { RemoteDesktopFrame } from '@lan-detective/shared-types';
import type { Db } from '../../../infrastructure/db.ts';

// Remote desktop frames are transient: never written to a table. The JPEG travels from the agent's
// result upload to the technician's waiting request through this in-memory relay, and between API
// instances through PostgreSQL's notification channel (pg_notify, delivered on COMMIT, not stored
// in any table). `endpoint_commands.result_data` keeps only the frame's metadata (size, timing,
// capture mode) and the session's start/stop stay in the audit log.

/** pg_notify channel carrying frame chunks between API instances. */
export const RD_FRAME_CHANNEL = 'ld_rd_frame';
/** A frame no one has fetched is dropped after this. */
export const FRAME_TTL_MS = 60_000;
/** pg_notify payloads must stay under 8000 bytes; a chunk plus its header stays well below. */
const CHUNK_CHARS = 7_000;

interface Held {
  commandId: string;
  frame: RemoteDesktopFrame;
  at: number;
}

/** The latest frame of each endpoint with a session open on this API instance. */
const latest = new Map<string, Held>();
/** Frames arriving in chunks from another instance: commandId → parts. */
const assembling = new Map<string, { endpointId: string; parts: (string | undefined)[]; got: number; at: number }>();

function sweep(now: number): void {
  for (const [k, v] of latest) if (now - v.at > FRAME_TTL_MS) latest.delete(k);
  for (const [k, v] of assembling) if (now - v.at > 10_000) assembling.delete(k);
}

export function holdFrame(endpointId: string, commandId: string, frame: RemoteDesktopFrame): void {
  const now = Date.now();
  sweep(now);
  latest.set(endpointId, { commandId, frame, at: now });
}

/** The latest frame of an endpoint held on this instance (any command), or null. */
export function latestFrame(endpointId: string): { commandId: string; frame: RemoteDesktopFrame } | null {
  const h = latest.get(endpointId);
  if (!h || Date.now() - h.at > FRAME_TTL_MS) return null;
  return { commandId: h.commandId, frame: h.frame };
}

/** The frame of one capture command, if it is (still) the latest one held. */
export function frameForCommand(endpointId: string, commandId: string): RemoteDesktopFrame | null {
  const h = latestFrame(endpointId);
  return h && h.commandId === commandId ? h.frame : null;
}

/** Ends a session's frames on this instance (and, through clearFrames' notification, on the others). */
export function dropFrames(endpointId: string): void {
  latest.delete(endpointId);
}

/** Number of frames held (tests). */
export function heldFrameCount(): number {
  return latest.size;
}

/**
 * Sends the frame to the other API instances, inside the caller's transaction (delivered on
 * COMMIT, so a rolled-back upload sends nothing). Chunk 0 is the metadata, 1..n the JPEG.
 */
export async function publishFrame(db: Db, endpointId: string, commandId: string, frame: RemoteDesktopFrame): Promise<void> {
  const { jpeg_base64 = '', ...meta } = frame;
  const parts = [Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')];
  for (let i = 0; i < jpeg_base64.length; i += CHUNK_CHARS) parts.push(jpeg_base64.slice(i, i + CHUNK_CHARS));
  const n = parts.length;
  const payloads = parts.map((p, i) => `f|${commandId}|${endpointId}|${i}|${n}|${p}`);
  await db.query('SELECT pg_notify($1, p) FROM unnest($2::text[]) AS p', [RD_FRAME_CHANNEL, payloads]);
}

/** Tells every instance that an endpoint's session ended: its frames are dropped. */
export async function publishFramesCleared(db: Db, endpointId: string): Promise<void> {
  await db.query('SELECT pg_notify($1, $2)', [RD_FRAME_CHANNEL, `x|${endpointId}`]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Handler for RD_FRAME_CHANNEL notifications (every instance, this one included). */
export function onFrameNotification(payload: string): void {
  if (payload.startsWith('x|')) {
    const endpointId = payload.slice(2);
    if (UUID.test(endpointId)) dropFrames(endpointId);
    return;
  }
  const m = /^f\|([^|]+)\|([^|]+)\|(\d+)\|(\d+)\|(.*)$/s.exec(payload);
  if (!m) return;
  const [, commandId, endpointId, iRaw, nRaw, chunk] = m as unknown as [string, string, string, string, string, string];
  if (!UUID.test(commandId) || !UUID.test(endpointId)) return;
  const i = Number(iRaw);
  const n = Number(nRaw);
  if (!(n >= 1 && n <= 2_000 && i < n)) return;
  // The instance that received the upload holds the frame already.
  if (latest.get(endpointId)?.commandId === commandId) return;
  const now = Date.now();
  let a = assembling.get(commandId);
  if (!a) {
    sweep(now);
    a = { endpointId, parts: new Array(n), got: 0, at: now };
    assembling.set(commandId, a);
  }
  if (a.parts.length !== n || a.endpointId !== endpointId || a.parts[i] !== undefined) return;
  a.parts[i] = chunk;
  a.got++;
  if (a.got < n) return;
  assembling.delete(commandId);
  try {
    const meta = JSON.parse(Buffer.from(a.parts[0]!, 'base64').toString('utf8')) as Omit<RemoteDesktopFrame, 'jpeg_base64'>;
    holdFrame(endpointId, commandId, { ...meta, jpeg_base64: a.parts.slice(1).join('') } as RemoteDesktopFrame);
  } catch {
    // a malformed frame is dropped; the viewer asks for the next one
  }
}
