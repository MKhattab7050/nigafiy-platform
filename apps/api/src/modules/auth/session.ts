import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@lan-detective/shared-types';
import { AppError } from '../../common/http.ts';
import { randomToken, sha256 } from '../../common/crypto.ts';
import { env } from '../../config/env.ts';
import { systemPool } from '../../infrastructure/db.ts';

export const SESSION_COOKIE = 'ld_session';
const CSRF_HEADER = 'x-ld-csrf';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export async function createSession(res: Response, req: Request, userId: string, organizationId: string): Promise<void> {
  const token = randomToken(32);
  const expires = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000);
  await systemPool.query(
    `INSERT INTO sessions (user_id, token_hash, active_organization_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, sha256(token), organizationId, req.ip ?? null, (req.headers['user-agent'] ?? '').slice(0, 300), expires],
  );
  // Opaque random token; only its hash is stored. HttpOnly keeps it away from page scripts.
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    expires,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/' });
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 *  1. a custom header that a cross-site form/navigation cannot set (and we send no CORS approval), and
 *  2. if the browser sent an Origin header, it must be our own web origin.
 */
function assertNotCrossSite(req: Request): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (req.headers[CSRF_HEADER] !== '1') throw new AppError(403, 'csrf_rejected', 'Missing CSRF header');
  const origin = req.headers.origin;
  if (origin && origin !== env.WEB_ORIGIN) throw new AppError(403, 'csrf_rejected', 'Cross-origin request rejected');
}

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  organization_id: string;
  role: Role | null;
}

/** Resolves the session cookie to user + active organization + role (membership re-checked on every request). */
export async function requireSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  assertNotCrossSite(req);
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) throw new AppError(401, 'unauthenticated', 'Sign in required');
  const { rows } = await systemPool.query<SessionRow>(
    `SELECT s.id AS session_id, u.id AS user_id, u.email, s.active_organization_id AS organization_id, m.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.user_id = s.user_id AND m.organization_id = s.active_organization_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) throw new AppError(401, 'unauthenticated', 'Session expired, sign in again');
  if (!row.role) throw new AppError(403, 'forbidden', 'You are no longer a member of this organization');
  req.auth = { userId: row.user_id, userEmail: row.email, sessionId: row.session_id, organizationId: row.organization_id, role: row.role };
  // Best effort, throttled to once a minute per session.
  void systemPool
    .query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [row.session_id])
    .catch(() => undefined);
  next();
}
