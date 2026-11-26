import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Role } from '@nigafiy/shared-types';
import { env, tlsPinSha256 } from '../config/env.ts';
import { databaseUnavailableCode } from '../infrastructure/db.ts';
import { tlsStatus } from '../infrastructure/lan-tls.ts';
import { logger } from '../infrastructure/logger.ts';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'forbidden', message);

/** Validate an external payload. Everything crossing the API boundary goes through this. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      400,
      'validation_error',
      'The request is invalid',
      result.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export const uuidParam = z.uuid();
export const idParams = z.object({ id: z.uuid() });

export interface AuthContext {
  userId: string;
  userEmail: string;
  sessionId: string;
  organizationId: string;
  role: Role;
  /** Set when the session came from an SSO sign-in: it is pinned to that provider's organization. */
  ssoProviderId?: string | null;
}

export function auth(req: Request): AuthContext {
  if (!req.auth) throw new AppError(401, 'unauthenticated', 'Sign in required');
  return req.auth;
}

/**
 * The address a collector or endpoint agent should be given to reach this server: PUBLIC_URL when
 * configured, otherwise the origin the request reached. Behind the web app's /api proxy that is the
 * browser's origin (X-Forwarded-Host / -Proto, honoured per TRUST_PROXY), which also serves /api/v1/*.
 */
export function publicServerUrl(req: Request): { server_url: string; server_url_source: 'configured' | 'request' | 'lan'; tls_pin_sha256: string | null } {
  // Explicit pin / certificate files first; otherwise the built-in LAN TLS CA (when it is serving).
  const tls = tlsStatus();
  const tls_pin_sha256 = tlsPinSha256() ?? tls.pin_sha256;
  if (env.PUBLIC_URL) return { server_url: env.PUBLIC_URL, server_url_source: 'configured', tls_pin_sha256 };
  const host = req.host || req.get('host') || 'localhost';
  // Opened on this computer (the desktop app, or localhost in a browser): that address means nothing to
  // a phone or another computer, so hand out the HTTPS listener on this computer's LAN address.
  const lan = LOOPBACK_HOST.test(host.replace(/:\d+$/, '')) && tls.mode !== 'off' && tls.https_port ? lanAddress(tls.ip_addresses) : null;
  if (lan) return { server_url: `https://${lan.includes(':') ? `[${lan}]` : lan}:${tls.https_port}`, server_url_source: 'lan', tls_pin_sha256 };
  return { server_url: `${req.protocol}://${host}`, server_url_source: 'request', tls_pin_sha256 };
}

const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/** The address other devices most likely reach: a private IPv4 (home ranges first), then any other. */
export function lanAddress(ips: string[]): string | null {
  const v4 = ips.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.'));
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const best = [...v4].sort((a, b) => rank(a) - rank(b))[0];
  if (best) return best;
  return ips.find((ip) => ip.includes(':') && !/^(::1|fe80:)/i.test(ip)) ?? null;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, technician: 1, admin: 2, owner: 3 };

/** Server-side authorization. The frontend hiding a button is never the control. */
export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const ctx = auth(req);
    if (ROLE_RANK[ctx.role] < ROLE_RANK[min]) throw forbidden();
    next();
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, request_id: req.id } });
    return;
  }
  const e = err as { type?: string; status?: number; code?: string };
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large', request_id: req.id } });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON', request_id: req.id } });
    return;
  }
  if (e?.code === '23505') {
    res.status(409).json({ error: { code: 'conflict', message: 'A record with these values already exists', request_id: req.id } });
    return;
  }
  // The database is busy or away: a clear, retryable 503 instead of a generic 500 (or a request that hangs).
  const unavailable = databaseUnavailableCode(err);
  if (unavailable) {
    logger.warn({ err, request_id: req.id, path: req.path, method: req.method, code: unavailable }, 'database unavailable for request');
    res.setHeader('Retry-After', '5');
    res.status(503).json({ error: { code: unavailable, message: unavailable === 'service_busy' ? 'The server is busy, try again in a moment' : 'The database is not reachable right now', request_id: req.id } });
    return;
  }
  // Unexpected: log everything server-side, reveal nothing to the client.
  logger.error({ err, request_id: req.id, path: req.path, method: req.method }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on our side', request_id: req.id } });
}
