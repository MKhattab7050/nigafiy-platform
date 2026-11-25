/**
 * Delay before retry number `attempt` (0-based) when the Nigafiy server cannot be reached:
 * 2 s, 4 s, 8 s, 16 s, 32 s, then 60 s at most, each with ±20 % jitter so many open tabs do not
 * retry in lockstep after a server restart. Deterministic for a given `random`.
 */
export const RETRY_BASE_MS = 2_000;
export const RETRY_CAP_MS = 60_000;

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(0, Math.floor(attempt));
  const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(n, 30));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.min(RETRY_CAP_MS, Math.round(base * jitter));
}

/** True for failures worth retrying (server down, proxy error, overload); 401/403 and other 4xx are not. */
export function isRetryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
