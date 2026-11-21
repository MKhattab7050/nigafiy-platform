import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { InvitationPreview, Me, MfaRequirement, Role } from '@lan-detective/shared-types';
import { AppError, auth, parse } from '../../common/http.ts';
import { timeZoneSchema } from '../../common/timezone.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, randomToken, sha256, verifyPassword } from '../../common/crypto.ts';
import { env } from '../../config/env.ts';
import { systemPool, withSystem } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { createDefaultChecks } from '../monitoring/index.ts';
import { accountMailConfigured, anyAccountMailConfigured, sendAccountEmail } from '../notifications/index.ts';
import { mfaRouter } from './mfa.ts';
import { SESSION_COOKIE, clearSessionCookie, createSession, readCookie, requireSession } from './session.ts';
import { webAppUrl } from './team.ts';

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
  /** IANA zone of the first site (e.g. the browser's). Absent: UTC, as before. */
  timezone: timeZoneSchema.optional(),
});
const loginSchema = z.object({ email, password: z.string().min(1).max(200) });

export const authRouter: Router = Router();

function requireCsrfHeader(req: import('express').Request): void {
  if (req.headers['x-ld-csrf'] !== '1') throw new AppError(403, 'csrf_rejected', 'Missing CSRF header');
  const origin = req.headers.origin;
  if (origin && origin !== env.WEB_ORIGIN) throw new AppError(403, 'csrf_rejected', 'Cross-origin request rejected');
}

authRouter.get('/options', async (_req, res) => {
  res.json({
    allow_registration: env.ALLOW_REGISTRATION,
    account_mail_configured: await anyAccountMailConfigured(),
  });
});

authRouter.post('/register', credentialLimiter, async (req, res) => {
  requireCsrfHeader(req);
  if (!env.ALLOW_REGISTRATION) throw new AppError(403, 'registration_disabled', 'Self-service registration is disabled');
  const body = parse(registerSchema, req.body);
  const passwordHash = await hashPassword(body.password);

  const created = await withSystem(async (db) => {
    const existing = await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [body.email]);
    if (existing.rowCount) throw new AppError(409, 'email_in_use', 'An account with this email already exists');
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, last_login_at) VALUES ($1,$2,$3,now()) RETURNING id`,
      [body.email, passwordHash, body.display_name],
    );
    const org = await db.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [body.organization_name]);
    const userId = user.rows[0]!.id;
    const orgId = org.rows[0]!.id;
    await db.query(`INSERT INTO memberships (user_id, organization_id, role, status) VALUES ($1,$2,'owner','active')`, [userId, orgId]);
    const site = await db.query<{ id: string }>(`INSERT INTO sites (organization_id, name, timezone) VALUES ($1,$2,$3) RETURNING id`, [orgId, body.site_name, body.timezone ?? 'UTC']);
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
  const { rows } = await systemPool.query<{
    id: string;
    email: string;
    password_hash: string;
    mfa_secret_enc: string | null;
    mfa_locked_until: Date | null;
  }>(
    `SELECT id, email, password_hash, mfa_secret_enc, mfa_locked_until FROM users WHERE lower(email) = $1`,
    [body.email],
  );
  const user = rows[0];
  // Always run one password verification so response time does not reveal whether the account exists.
  const valid = await verifyPassword(body.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !valid) {
    logger.warn({ ip: req.ip }, 'failed login');
    throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
  }

  const memberships = await systemPool.query<{
    organization_id: string;
    role: Role;
    status: 'active' | 'deactivated';
    mfa_required: MfaRequirement;
  }>(
    `SELECT m.organization_id, m.role, m.status, o.mfa_required
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1
      ORDER BY (m.status = 'active') DESC, m.created_at`,
    [user.id],
  );
  if (!memberships.rowCount) {
    throw new AppError(403, 'no_organization', 'This account does not belong to any organization');
  }
  const activeMembership = memberships.rows.find((m) => m.status === 'active');
  if (!activeMembership) {
    throw new AppError(403, 'account_deactivated', 'Your account has been deactivated in this organization');
  }

  const orgId = activeMembership.organization_id;
  const role = activeMembership.role;
  const mfaRequired = activeMembership.mfa_required;

  if (user.mfa_secret_enc !== null) {
    if (user.mfa_locked_until && user.mfa_locked_until.getTime() > Date.now()) {
      throw new AppError(429, 'mfa_locked', 'Too many failed verification codes. Try again in 15 minutes.');
    }
    const mfaToken = randomToken(32);
    await systemPool.query(
      `INSERT INTO auth_tokens (user_id, organization_id, purpose, token_hash, expires_at)
       VALUES ($1,$2,'mfa_login',$3,now() + interval '5 minutes')`,
      [user.id, orgId, sha256(mfaToken)],
    );
    res.status(200).json({ ok: false, mfa_required: true, mfa_token: mfaToken });
    return;
  }

  const orgDemandsMfa = mfaRequired === 'all' || (mfaRequired === 'admins' && (role === 'owner' || role === 'admin'));
  if (orgDemandsMfa) {
    const mfaToken = randomToken(32);
    await systemPool.query(
      `INSERT INTO auth_tokens (user_id, organization_id, purpose, token_hash, expires_at)
       VALUES ($1,$2,'mfa_enroll',$3,now() + interval '10 minutes')`,
      [user.id, orgId, sha256(mfaToken)],
    );
    res.status(200).json({ ok: false, mfa_setup_required: true, mfa_token: mfaToken });
    return;
  }

  await systemPool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  await createSession(res, req, user.id, orgId);
  await systemPool.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, ip) VALUES ($1,$2,$3,'auth.login',$4)`,
    [orgId, user.id, user.email, req.ip ?? null],
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
    systemPool.query<{ id: string; email: string; display_name: string; locale: 'en' | 'ar'; mfa_enabled: boolean }>(
      `SELECT id, email, display_name, locale, (mfa_secret_enc IS NOT NULL) AS mfa_enabled FROM users WHERE id = $1`,
      [ctx.userId],
    ),
    systemPool.query<{ organization_id: string; organization_name: string; kind: string; mfa_required: MfaRequirement; role: Role }>(
      `SELECT m.organization_id, o.name AS organization_name, o.kind, o.mfa_required, m.role
         FROM memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.status = 'active' ORDER BY o.name`,
      [ctx.userId],
    ),
  ]);
  const active = memberships.rows.find((m) => m.organization_id === ctx.organizationId)!;
  const me: Me = {
    user: user.rows[0]!,
    organization: {
      id: active.organization_id,
      name: active.organization_name,
      kind: active.kind,
      mfa_required: active.mfa_required,
    },
    role: ctx.role,
    memberships: memberships.rows.map(({ organization_id, organization_name, role }) => ({ organization_id, organization_name, role })),
  };
  res.json(me);
});

authRouter.patch('/me', requireSession, async (req, res) => {
  const ctx = auth(req);
  const body = parse(
    z.object({
      locale: z.enum(['en', 'ar']).optional(),
      display_name: z.string().trim().min(1).max(80).optional(),
    }),
    req.body,
  );
  await systemPool.query(
    `UPDATE users SET locale = coalesce($2, locale), display_name = coalesce($3, display_name) WHERE id = $1`,
    [ctx.userId, body.locale ?? null, body.display_name ?? null],
  );
  res.json({ ok: true });
});

authRouter.post('/switch-organization', requireSession, async (req, res) => {
  const ctx = auth(req);
  const body = parse(z.object({ organization_id: z.uuid() }), req.body);
  // Only active organizations the user is a member of.
  const targetRes = await systemPool.query<{
    role: Role;
    mfa_required: MfaRequirement;
    has_mfa: boolean;
  }>(
    `SELECT m.role, o.mfa_required, (u.mfa_secret_enc IS NOT NULL) AS has_mfa
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
       JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status = 'active'`,
    [ctx.userId, body.organization_id],
  );
  const target = targetRes.rows[0];
  if (!target) throw new AppError(403, 'forbidden', 'You are not a member of that organization');

  const orgDemandsMfa =
    target.mfa_required === 'all' ||
    (target.mfa_required === 'admins' && (target.role === 'owner' || target.role === 'admin'));
  if (orgDemandsMfa && !target.has_mfa) {
    throw new AppError(403, 'mfa_required', 'This organization requires multi-factor authentication for your role');
  }

  const updated = await systemPool.query(
    `UPDATE sessions s SET active_organization_id = $2
      WHERE s.id = $1 AND s.user_id = $3`,
    [ctx.sessionId, body.organization_id, ctx.userId],
  );
  if (!updated.rowCount) throw new AppError(403, 'forbidden', 'You are not a member of that organization');
  res.json({ ok: true });
});

authRouter.post('/password', requireSession, async (req, res) => {
  const ctx = auth(req);
  const body = parse(
    z
      .object({
        current_password: z.string().min(1).max(200),
        new_password: password,
      })
      .strict(),
    req.body,
  );

  const userRes = await systemPool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
    ctx.userId,
  ]);
  const user = userRes.rows[0];
  if (!user || !(await verifyPassword(body.current_password, user.password_hash))) {
    throw new AppError(401, 'invalid_password', 'Current password is incorrect');
  }

  const newHash = await hashPassword(body.new_password);
  await withSystem(async (db) => {
    await db.query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [
      ctx.userId,
      newHash,
    ]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [ctx.userId, ctx.sessionId]);
    await db.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [ctx.userId]);
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, ip)
       VALUES ($1,$2,$3,'auth.password_changed','user',$4,$5)`,
      [ctx.organizationId, ctx.userId, ctx.userEmail, ctx.userId, req.ip ?? null],
    );
  });

  res.json({ ok: true });
});

authRouter.post('/forgot-password', credentialLimiter, async (req, res) => {
  requireCsrfHeader(req);
  const body = parse(z.object({ email }).strict(), req.body);

  const userRes = await systemPool.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE lower(email) = $1`,
    [body.email],
  );
  const user = userRes.rows[0];
  if (user) {
    const memberships = await systemPool.query<{ organization_id: string }>(
      `SELECT organization_id FROM memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at`,
      [user.id],
    );
    let mailOrgId: string | null = null;
    for (const m of memberships.rows) {
      if (await accountMailConfigured(m.organization_id)) {
        mailOrgId = m.organization_id;
        break;
      }
    }
    if (mailOrgId) {
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + 60 * 60_000);
      await systemPool.query(
        `INSERT INTO auth_tokens (user_id, organization_id, purpose, token_hash, expires_at)
         VALUES ($1,$2,'password_reset',$3,$4)`,
        [user.id, mailOrgId, sha256(token), expiresAt],
      );
      const resetUrl = `${webAppUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
      await sendAccountEmail(mailOrgId, user.email, {
        subject: '[LAN Detective] Reset your password',
        text: [
          'A password reset was requested for your LAN Detective account.',
          '',
          `Reset your password: ${resetUrl}`,
          `Expires: ${expiresAt.toISOString()}`,
          '',
          'If you did not request this, you can safely ignore this message.',
        ].join('\n'),
      });
    }
  }

  // Always return { ok: true } to prevent email enumeration.
  res.json({ ok: true });
});

authRouter.post('/reset-password', credentialLimiter, async (req, res) => {
  requireCsrfHeader(req);
  const body = parse(
    z
      .object({
        token: z.string().min(10).max(200),
        new_password: password,
      })
      .strict(),
    req.body,
  );

  const tokenRes = await systemPool.query<{
    id: string;
    user_id: string;
    organization_id: string | null;
    email: string;
  }>(
    `SELECT t.id, t.user_id, t.organization_id, u.email
       FROM auth_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.purpose = 'password_reset' AND t.used_at IS NULL AND t.expires_at > now()`,
    [sha256(body.token)],
  );
  const tokenRow = tokenRes.rows[0];
  if (!tokenRow) {
    throw new AppError(400, 'invalid_reset_token', 'This password reset link is invalid or has expired');
  }

  const newHash = await hashPassword(body.new_password);
  await withSystem(async (db) => {
    await db.query(
      `UPDATE users
          SET password_hash = $2,
              password_changed_at = now(),
              mfa_locked_until = NULL,
              mfa_failed_attempts = 0
        WHERE id = $1`,
      [tokenRow.user_id, newHash],
    );
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [tokenRow.user_id]);
    await db.query(
      `UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [tokenRow.user_id],
    );

    const orgId =
      tokenRow.organization_id ??
      (
        await db.query<{ organization_id: string }>(
          `SELECT organization_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1`,
          [tokenRow.user_id],
        )
      ).rows[0]?.organization_id;
    if (orgId) {
      await db.query(
        `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, ip)
         VALUES ($1,$2,$3,'auth.password_reset','user',$4,$5)`,
        [orgId, tokenRow.user_id, tokenRow.email, tokenRow.user_id, req.ip ?? null],
      );
    }
  });

  res.json({ ok: true });
});

authRouter.get('/invitations/:token', async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.params);
  const invRes = await systemPool.query<{
    email: string;
    role: Role;
    organization_name: string;
    invited_by_name: string | null;
    expires_at: string;
  }>(
    `SELECT i.email, i.role, o.name AS organization_name, i.invited_by_name, i.expires_at
       FROM invitations i
       JOIN organizations o ON o.id = i.organization_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
    [sha256(token)],
  );
  const inv = invRes.rows[0];
  if (!inv) {
    throw new AppError(404, 'invitation_not_found', 'This invitation link is invalid or has expired');
  }

  const existing = await systemPool.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [inv.email]);
  const preview: InvitationPreview = {
    email: inv.email,
    role: inv.role,
    organization_name: inv.organization_name,
    invited_by_name: inv.invited_by_name,
    expires_at: inv.expires_at,
    existing_user: Boolean(existing.rowCount),
  };
  res.json(preview);
});

authRouter.post('/invitations/:token/accept', credentialLimiter, async (req, res) => {
  requireCsrfHeader(req);
  const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.params);
  const body = parse(
    z.object({
      display_name: z.string().trim().min(1).max(80).optional(),
      password: z.string().min(1).max(200),
    }),
    req.body,
  );

  const accepted = await withSystem(async (db) => {
    const invRes = await db.query<{
      id: string;
      organization_id: string;
      email: string;
      role: Role;
      mfa_required: MfaRequirement;
    }>(
      `SELECT i.id, i.organization_id, i.email, i.role, o.mfa_required
         FROM invitations i
         JOIN organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
        FOR UPDATE OF i`,
      [sha256(token)],
    );
    const inv = invRes.rows[0];
    if (!inv) {
      throw new AppError(404, 'invitation_not_found', 'This invitation link is invalid or has expired');
    }

    const existingRes = await db.query<{ id: string; email: string; password_hash: string; mfa_secret_enc: string | null }>(
      `SELECT id, email, password_hash, mfa_secret_enc FROM users WHERE lower(email) = lower($1)`,
      [inv.email],
    );
    let userId: string;
    let userEmail: string;
    let hasMfa = false;
    const orgDemandsMfa =
      inv.mfa_required === 'all' || (inv.mfa_required === 'admins' && (inv.role === 'owner' || inv.role === 'admin'));

    if (existingRes.rows[0]) {
      const existing = existingRes.rows[0];
      const valid = await verifyPassword(body.password, existing.password_hash);
      if (!valid) {
        throw new AppError(401, 'invalid_credentials', 'Password is incorrect for this existing account');
      }
      hasMfa = existing.mfa_secret_enc !== null;
      if (!hasMfa && !orgDemandsMfa) {
        await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [existing.id]);
      }
      userId = existing.id;
      userEmail = existing.email;
    } else {
      const validNewPw = password.safeParse(body.password);
      if (!validNewPw.success) {
        throw new AppError(400, 'validation_error', 'Use at least 10 characters for your password');
      }
      const passwordHash = await hashPassword(body.password);
      const displayName = body.display_name || inv.email.split('@')[0] || 'User';
      const createdUser = await db.query<{ id: string; email: string }>(
        `INSERT INTO users (email, password_hash, display_name, last_login_at)
         VALUES ($1,$2,$3,$4)
         RETURNING id, email`,
        [inv.email.toLowerCase(), passwordHash, displayName, orgDemandsMfa ? null : new Date()],
      );
      userId = createdUser.rows[0]!.id;
      userEmail = createdUser.rows[0]!.email;
    }

    await db.query(
      `INSERT INTO memberships (user_id, organization_id, role, status, deactivated_at, deactivated_by)
       VALUES ($1,$2,$3,'active',NULL,NULL)
       ON CONFLICT (user_id, organization_id)
       DO UPDATE SET role = EXCLUDED.role, status = 'active', deactivated_at = NULL, deactivated_by = NULL`,
      [userId, inv.organization_id, inv.role],
    );

    await db.query(`UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [
      inv.id,
      userId,
    ]);

    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
       VALUES ($1,$2,$3,'invitation.accepted','invitation',$4,$5,$6)`,
      [
        inv.organization_id,
        userId,
        userEmail,
        inv.id,
        JSON.stringify({ email: userEmail, role: inv.role }),
        req.ip ?? null,
      ],
    );

    if (hasMfa) {
      const mfaToken = randomToken(32);
      await db.query(
        `INSERT INTO auth_tokens (user_id, organization_id, purpose, token_hash, expires_at)
         VALUES ($1,$2,'mfa_login',$3,now() + interval '5 minutes')`,
        [userId, inv.organization_id, sha256(mfaToken)],
      );
      return { userId, organizationId: inv.organization_id, next: 'mfa_login' as const, mfaToken };
    }
    if (orgDemandsMfa) {
      const mfaToken = randomToken(32);
      await db.query(
        `INSERT INTO auth_tokens (user_id, organization_id, purpose, token_hash, expires_at)
         VALUES ($1,$2,'mfa_enroll',$3,now() + interval '10 minutes')`,
        [userId, inv.organization_id, sha256(mfaToken)],
      );
      return { userId, organizationId: inv.organization_id, next: 'mfa_enroll' as const, mfaToken };
    }

    return { userId, organizationId: inv.organization_id, next: 'session' as const, mfaToken: null };
  });

  if (accepted.next === 'mfa_login') {
    res.json({ ok: false, mfa_required: true, mfa_token: accepted.mfaToken });
    return;
  }
  if (accepted.next === 'mfa_enroll') {
    res.json({ ok: false, mfa_setup_required: true, mfa_token: accepted.mfaToken });
    return;
  }

  await createSession(res, req, accepted.userId, accepted.organizationId);
  res.json({ ok: true });
});

authRouter.use(mfaRouter);
