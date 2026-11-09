import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Me, Role } from '@lan-detective/shared-types';
import { AppError, auth, parse } from '../../common/http.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, sha256, verifyPassword } from '../../common/crypto.ts';
import { env } from '../../config/env.ts';
import { systemPool, withSystem } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { createDefaultChecks } from '../monitoring/defaults.ts';
import { SESSION_COOKIE, clearSessionCookie, createSession, readCookie, requireSession } from './session.ts';

const credentialLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } },
});

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(10, 'Use at least 10 characters').max(200);

const registerSchema = z.object({
  email,
  password,
  display_name: z.string().trim().min(1).max(80),
  organization_name: z.string().trim().min(2).max(80),
  site_name: z.string().trim().min(1).max(80).default('Main site'),
});
const loginSchema = z.object({ email, password: z.string().min(1).max(200) });

export const authRouter: Router = Router();

function requireCsrfHeader(req: import('express').Request): void {
  if (req.headers['x-ld-csrf'] !== '1') throw new AppError(403, 'csrf_rejected', 'Missing CSRF header');
}

authRouter.post('/register', credentialLimiter, async (req, res) => {
  requireCsrfHeader(req);
  if (!env.ALLOW_REGISTRATION) throw new AppError(403, 'registration_disabled', 'Self-service registration is disabled');
  const body = parse(registerSchema, req.body);
  const passwordHash = await hashPassword(body.password);

  const created = await withSystem(async (db) => {
    const existing = await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [body.email]);
    if (existing.rowCount) throw new AppError(409, 'email_in_use', 'An account with this email already exists');
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id`,
      [body.email, passwordHash, body.display_name],
    );
    const org = await db.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [body.organization_name]);
    const userId = user.rows[0]!.id;
    const orgId = org.rows[0]!.id;
    await db.query(`INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,'owner')`, [userId, orgId]);
    const site = await db.query<{ id: string }>(`INSERT INTO sites (organization_id, name) VALUES ($1,$2) RETURNING id`, [orgId, body.site_name]);
    await createDefaultChecks(db, orgId, site.rows[0]!.id);
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, ip) VALUES ($1,$2,$3,'organization.created','organization',$4,$5)`,
      [orgId, userId, body.email, orgId, req.ip ?? null],
    );
    return { userId, orgId };
  });

  await createSession(res, req, created.userId, created.orgId);
  logger.info({ user_id: created.userId, organization_id: created.orgId }, 'account registered');
  res.status(201).json({ ok: true });
});

authRouter.post('/login', credentialLimiter, async (req, res) => {
  requireCsrfHeader(req);
  const body = parse(loginSchema, req.body);
  const { rows } = await systemPool.query<{ id: string; password_hash: string }>(
    `SELECT id, password_hash FROM users WHERE lower(email) = $1`,
    [body.email],
  );
  const user = rows[0];
  // Always run one password verification so response time does not reveal whether the account exists.
  const valid = await verifyPassword(body.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !valid) {
    logger.warn({ ip: req.ip }, 'failed login');
    throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
  }
  const membership = await systemPool.query<{ organization_id: string }>(
    `SELECT organization_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1`,
    [user.id],
  );
  const orgId = membership.rows[0]?.organization_id;
  if (!orgId) throw new AppError(403, 'no_organization', 'This account does not belong to any organization');
  await createSession(res, req, user.id, orgId);
  await systemPool.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, ip) VALUES ($1,$2,$3,'auth.login',$4)`,
    [orgId, user.id, body.email, req.ip ?? null],
  );
  res.json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  requireCsrfHeader(req);
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await systemPool.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireSession, async (req, res) => {
  const ctx = auth(req);
  const [user, memberships] = await Promise.all([
    systemPool.query<{ id: string; email: string; display_name: string; locale: 'en' | 'ar' }>(
      `SELECT id, email, display_name, locale FROM users WHERE id = $1`,
      [ctx.userId],
    ),
    systemPool.query<{ organization_id: string; organization_name: string; kind: string; role: Role }>(
      `SELECT m.organization_id, o.name AS organization_name, o.kind, m.role
         FROM memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY o.name`,
      [ctx.userId],
    ),
  ]);
  const active = memberships.rows.find((m) => m.organization_id === ctx.organizationId)!;
  const me: Me = {
    user: user.rows[0]!,
    organization: { id: active.organization_id, name: active.organization_name, kind: active.kind },
    role: ctx.role,
    memberships: memberships.rows.map(({ organization_id, organization_name, role }) => ({ organization_id, organization_name, role })),
  };
  res.json(me);
});

authRouter.patch('/me', requireSession, async (req, res) => {
  const ctx = auth(req);
  const body = parse(z.object({ locale: z.enum(['en', 'ar']) }), req.body);
  await systemPool.query(`UPDATE users SET locale = $2 WHERE id = $1`, [ctx.userId, body.locale]);
  res.json({ ok: true });
});

authRouter.post('/switch-organization', requireSession, async (req, res) => {
  const ctx = auth(req);
  const body = parse(z.object({ organization_id: z.uuid() }), req.body);
  // Only organizations the user is actually a member of.
  const updated = await systemPool.query(
    `UPDATE sessions s SET active_organization_id = $2
      WHERE s.id = $1 AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = s.user_id AND m.organization_id = $2)`,
    [ctx.sessionId, body.organization_id],
  );
  if (!updated.rowCount) throw new AppError(403, 'forbidden', 'You are not a member of that organization');
  res.json({ ok: true });
});
