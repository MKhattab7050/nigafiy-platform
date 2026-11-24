// The transfer queue's rules, kept pure so they are unit-tested (sha256.test.ts).

export interface HashAnswer {
  total_size?: number;
  /** Set by the agent only for an interrupted upload it started itself and can still continue. */
  upload_next?: number;
}

/**
 * Where an interrupted upload continues. Only at the offset the agent reports for its own upload
 * (the agent refuses any other continuation anyway); otherwise the upload starts again from the
 * beginning, which replaces the partial file and so needs the operator's overwrite confirmation.
 */
export function uploadResumePoint(fileSize: number, hash: HashAnswer | null): { kind: 'resume'; offset: number } | { kind: 'restart' } {
  const next = hash?.upload_next;
  if (typeof next === 'number' && next >= 0 && next <= fileSize && next === hash?.total_size) return { kind: 'resume', offset: next };
  return { kind: 'restart' };
}

/**
 * A lost connection, a timeout or an offline agent leaves the transfer resumable where it stopped;
 * a refusal (path guards, roles, checksum) fails it; the operator's Cancel cancels it.
 */
export function classifyTransferError(err: { status?: number; code?: string; message?: string }): 'interrupted' | 'failed' | 'cancelled' {
  if (err.code === 'cancelled' || err.status === 499) return 'cancelled';
  if (err.status === 0 || err.status === 504 || err.status === 502 || err.status === 503 || err.code === 'timeout' || err.code === 'endpoint_offline' || err.code === 'network_error') {
    return 'interrupted';
  }
  return 'failed';
}
