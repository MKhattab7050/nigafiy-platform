import type { EndpointCommand, RemoteFileResponse } from '@nigafiy/shared-types';
import { ApiError, api } from '@/lib/api';

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

const TRANSIENT_CODES = new Set(['request_timeout', 'network_error', 'endpoint_offline', 'rate_limited', 'timeout', 'expired']);

export function toFsError(err: unknown): FsError {
  if (err instanceof FsError) return err;
  if (err instanceof ApiError) {
    const transient = err.status === 0 || err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504 || TRANSIENT_CODES.has(err.code);
    return new FsError(transient ? 'transient' : 'refused', err.message, err.code);
  }
  const e = err as { message?: string } | null;
  return new FsError('refused', e?.message ?? String(err));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fsCall(
  endpointId: string,
  payload: Record<string, unknown>,
  { deadlineMs = 90_000, stopped }: { deadlineMs?: number; stopped?: () => boolean } = {},
): Promise<RemoteFileResponse> {
  const start = Date.now();
  let cmd: EndpointCommand;
  try {
    cmd = await api<EndpointCommand>(`/endpoints/${endpointId}/commands?wait_ms=6000`, { method: 'POST', body: { kind: 'fs_op', ...payload }, timeoutMs: 45_000 });
  } catch (err) {
    throw toFsError(err);
  }
  for (;;) {
    if (cmd.status === 'completed') return (cmd.result_data ?? {}) as unknown as RemoteFileResponse;
    if (cmd.status === 'failed') throw new FsError('refused', cmd.error || 'The file operation failed on the device', 'fs_op_failed');
    if (cmd.status === 'expired') throw new FsError('transient', 'The device did not take the request in time', 'expired');
    if (stopped?.()) throw new FsError('cancelled', 'stopped');
    if (Date.now() - start > deadlineMs) throw new FsError('transient', 'The device did not answer in time', 'timeout');
    try {
      cmd = await api<EndpointCommand>(`/endpoints/${endpointId}/commands/${cmd.id}?wait_ms=25000`, { timeoutMs: 40_000 });
    } catch (err) {
      const e = toFsError(err);
      if (e.kind !== 'transient') throw e;
      await sleep(1000);
    }
  }
}
