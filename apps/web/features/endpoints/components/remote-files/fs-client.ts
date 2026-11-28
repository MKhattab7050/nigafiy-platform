import type { EndpointCommand, RemoteFileResponse } from '@nigafiy/shared-types';
import { ApiError, api } from '@/lib/api';
import { base64ToUint8Array } from './file-utils';

// One file-manager command, sent and waited on until the agent answers: the POST waits up to 6 s,
// then GET /endpoints/:id/commands/:cid waits again (25 s at a time) until `deadlineMs`, so a slow
// step (a whole-file checksum of a large file) is not mistaken for a lost connection.

/** transient: a lost connection, a timeout or an offline device; the transfer retries by itself. */
export type FsErrorKind = 'transient' | 'refused' | 'cancelled';

export class FsError extends Error {
  readonly kind: FsErrorKind;
  readonly code: string;
  constructor(kind: FsErrorKind, message: string, code = '') {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

const TRANSIENT_CODES = new Set(['request_timeout', 'network_error', 'endpoint_offline', 'rate_limited', 'timeout', 'expired', 'relay_piece_missing']);

export function toFsError(err: unknown): FsError {
  if (err instanceof FsError) return err;
  if (err instanceof ApiError) {
    const transient = err.status === 0 || err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504 || TRANSIENT_CODES.has(err.code);
    return new FsError(transient ? 'transient' : 'refused', err.message, err.code);
  }
  const e = err as { message?: string } | null;
  return new FsError('refused', e?.message ?? String(err));
}

/** A command's result plus its id (a relayed download's bytes are fetched by it). */
export type FsResult = RemoteFileResponse & { command_id?: string; relayed?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A queued request the device has not taken by then means the device is gone. */
const NOT_TAKEN_MS = 20_000;

export async function fsCall(
  endpointId: string,
  payload: Record<string, unknown>,
  { deadlineMs = 90_000, stopped }: { deadlineMs?: number; stopped?: () => boolean } = {},
): Promise<FsResult> {
  const start = Date.now();
  let cmd: EndpointCommand | undefined;
  // A "conflict" answer means the server rolled the request back (two first requests of an
  // organization met while it set itself up), so nothing was queued: sending it again is safe.
  for (let attempt = 0; !cmd; attempt++) {
    try {
      cmd = await api<EndpointCommand>(`/endpoints/${endpointId}/commands?wait_ms=6000`, { method: 'POST', body: { kind: 'fs_op', ...payload }, timeoutMs: 45_000 });
    } catch (err) {
      if (attempt < 2 && (err as { code?: string })?.code === 'conflict') {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw toFsError(err);
    }
  }
  for (;;) {
    if (!cmd) throw new FsError('transient', 'No answer', 'network_error');
    if (cmd.status === 'completed') return { ...(cmd.result_data ?? {}), command_id: cmd.id } as unknown as FsResult;
    // A piece the device could not fetch from the server (expired, another server): send it again.
    if (cmd.status === 'failed' && cmd.error?.startsWith('relay piece missing')) throw new FsError('transient', cmd.error, 'relay_piece_missing');
    if (cmd.status === 'failed') throw new FsError('refused', cmd.error || 'The file operation failed on the device', 'fs_op_failed');
    if (cmd.status === 'expired') throw new FsError('transient', 'The device did not take the request in time', 'expired');
    if (stopped?.()) throw new FsError('cancelled', 'stopped');
    if (Date.now() - start > deadlineMs) throw new FsError('transient', 'The device did not answer in time', 'timeout');
    // The agent takes a queued request within milliseconds; still untaken after 20 s, it has gone
    // (restarted, lost its network). Say so now and retry, instead of a silent wait to the deadline.
    // A transfer resumes from what the device really has, so a late delivery does no harm.
    if (cmd.status === 'pending' && Date.now() - start > NOT_TAKEN_MS) throw new FsError('transient', 'The device is not answering', 'endpoint_offline');
    try {
      // Not yet taken: look again sooner, so a device that went away is noticed in about 20 s.
      const waitMs: number = cmd.status === 'pending' ? 7_000 : 25_000;
      cmd = await api<EndpointCommand>(`/endpoints/${endpointId}/commands/${cmd.id}?wait_ms=${waitMs}`, { timeoutMs: 40_000 });
    } catch (err) {
      const e = toFsError(err);
      if (e.kind !== 'transient') throw e;
      await sleep(1000);
    }
  }
}

// ── Piece bytes apart from the commands (docs/roadmap/2026-11-28-file-transfer-speed.md) ──────
// Binary both ways through the server; the server falls back to base64 inside the command for a
// device that cannot, so these work with every agent.

async function raw(path: string, init: { method: string; body?: Uint8Array }): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: init.method,
      credentials: 'same-origin',
      headers: { 'X-LD-CSRF': '1', ...(init.body ? { 'Content-Type': 'application/octet-stream' } : {}) },
      body: init.body as BodyInit | undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new FsError('transient', 'Cannot reach the Nigafiy server', 'network_error');
  }
  if (!res.ok) {
    let code = 'http_error';
    let message = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      code = j.error?.code || code;
      message = j.error?.message || message;
    } catch {
      /* not JSON */
    }
    throw toFsError(new ApiError(res.status, code, message));
  }
  return res;
}

/** Reads one piece of a file: the result (checks, size, time) and its bytes. */
export async function fsRead(
  endpointId: string,
  payload: { path: string; offset: number; length: number },
  opts: { deadlineMs?: number; stopped?: () => boolean } = {},
): Promise<{ res: FsResult; data: Uint8Array }> {
  const res = await fsCall(endpointId, { op: 'download', ...payload, relay: true }, opts);
  if (res.relayed && res.command_id) {
    const r = await raw(`/endpoints/${endpointId}/commands/${res.command_id}/data`, { method: 'GET' });
    return { res, data: new Uint8Array(await r.arrayBuffer()) };
  }
  return { res, data: res.data_base64 ? base64ToUint8Array(res.data_base64) : new Uint8Array() };
}

/** Sends one upload piece's bytes to the server; the id is what the upload command refers to. */
export async function fsStage(endpointId: string, data: Uint8Array): Promise<string> {
  const r = await raw(`/endpoints/${endpointId}/file-data`, { method: 'POST', body: data });
  return ((await r.json()) as { id: string }).id;
}

/**
 * Writes one upload piece: the bytes go up raw, the command refers to them. `staged` is the id of
 * bytes already sent with fsStage (the next piece goes up while the device writes the one before).
 */
export async function fsWrite(endpointId: string, payload: Record<string, unknown>, data: Uint8Array, staged?: Promise<string>): Promise<FsResult> {
  if (data.length === 0) return fsCall(endpointId, { ...payload, op: 'upload', data_base64: '' });
  const id = await (staged ?? fsStage(endpointId, data));
  return fsCall(endpointId, { ...payload, op: 'upload', data_ref: id });
}
