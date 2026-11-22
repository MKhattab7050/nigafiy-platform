import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Role } from '@lan-detective/shared-types';
import { env, tlsPinSha256 } from '../config/env.ts';
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
export function publicServerUrl(req: Request): { server_url: string; server_url_source: 'configured' | 'request'; tls_pin_sha256: string | null } {
  const tls_pin_sha256 = tlsPinSha256();
  if (env.PUBLIC_URL) return { server_url: env.PUBLIC_URL, server_url_source: 'configured', tls_pin_sha256 };
  const host = req.host || req.get('host') || 'localhost';
  return { server_url: `${req.protocol}://${host}`, server_url_source: 'request', tls_pin_sha256 };
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
  // Unexpected: log everything server-side, reveal nothing to the client.
  logger.error({ err, request_id: req.id, path: req.path, method: req.method }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on our side', request_id: req.id } });
}
