'use client';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: { path: string; message: string }[];
  /** Structured details that are not a validation list (e.g. { reason, until } of a login pause, { note } of an unsupported capability). */
  info?: Record<string, unknown>;
  /** The server's request id (quote it when reporting a problem); shown under "Details". */
  requestId?: string;
  /**
   * True when `message` is already a sentence in the user's language (a screen translated it itself).
   * Otherwise `message` is the API's technical English: ErrorNote shows the translation of `code`
   * (lib/i18n/error-messages.ts) and keeps the message under "Details".
   */
  localized = false;
  constructor(status: number, code: string, message: string, details?: { path: string; message: string }[], info?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.info = info;
  }
}

/**
 * How long a request may take before the screen stops waiting and says the server is not answering
 * (a spinner that never ends was what people saw when the API hung). Calls that really take long,
 * such as writing or restoring a backup, pass `timeoutMs: 0` (no limit).
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** All API access goes through the same-origin /api proxy with the session cookie. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  let res: Response;
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: { 'X-LD-CSRF': '1', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    // Technical text only: the UI shows the translation of the code (lib/i18n/error-messages.ts);
    // a timeout (status 0) is worded like "can't reach the server", with the code under "Details".
    if (signal?.aborted || (err as { name?: string } | null)?.name === 'TimeoutError') {
      throw new ApiError(0, 'request_timeout', `The Nigafiy server did not answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw new ApiError(0, 'network_error', 'Cannot reach the Nigafiy server');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page from a proxy */
  }
  if (!res.ok) {
    const err = (json as { error?: { code: string; message: string; details?: unknown; request_id?: unknown } } | null)?.error;
    const details = err?.details;
    // The message stays technical (shown under "Details"); a non-JSON answer (a proxy's error page)
    // gets `http_error`, which the UI words by HTTP status.
    const error = new ApiError(
      res.status,
      typeof err?.code === 'string' && err.code ? err.code : 'http_error',
      typeof err?.message === 'string' && err.message ? err.message : `Request failed (${res.status})`,
      Array.isArray(details) ? (details as ApiError['details']) : undefined,
      details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined,
    );
    if (typeof err?.request_id === 'string') error.requestId = err.request_id;
    throw error;
  }
  return json as T;
}

/** `err` with a message the screen already translated (keeps code, details and request id for "Details"). */
export function localizedApiError(err: ApiError, message: string): ApiError {
  const copy = new ApiError(err.status, err.code, message, err.details, err.info);
  copy.requestId = err.requestId;
  copy.localized = err.localized || message !== err.message;
  return copy;
}

/** Marks an error whose message the screen wrote in the user's language. */
export function markLocalized<E extends ApiError>(err: E): E {
  err.localized = true;
  return err;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
