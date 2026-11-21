'use client';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: { path: string; message: string }[];
  /** Structured details that are not a validation list (e.g. { reason, until } of a login pause, { note } of an unsupported capability). */
  info?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: { path: string; message: string }[], info?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.info = info;
  }
}

/** All API access goes through the same-origin /api proxy with the session cookie. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: { 'X-LD-CSRF': '1', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the LAN Detective server');
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
    const err = (json as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
    const details = err?.details;
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `Request failed (${res.status})`,
      Array.isArray(details) ? (details as ApiError['details']) : undefined,
      details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined,
    );
  }
  return json as T;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
