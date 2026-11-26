import { randomBytes } from 'node:crypto';
import { type Request, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Role } from '@nigafiy/shared-types';
import { decryptSecret, encryptSecret, sha256, verifyPassword } from '../../common/crypto.ts';
import { AppError, parse } from '../../common/http.ts';
import { env, isOwnOrigin } from '../../config/env.ts';
import { systemPool, withSystem } from '../../infrastructure/db.ts';
import { SESSION_COOKIE, createSession, readCookie, requireSession } from './session.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.ts';
import { limiterStore } from '../../infrastructure/rate-limit.ts';

export const mfaRouter: Router = Router();

const mfaLimiter = rateLimit({
  store: limiterStore('auth:mfa'),
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } },
});

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function requireCsrfHeader(req: Request): void {
  if (req.headers['x-ld-csrf'] !== '1') throw new AppError(403, 'csrf_rejected', 'Missing CSRF header');
  const origin = req.headers.origin;
  if (origin && !isOwnOrigin(origin, req)) throw new AppError(403, 'csrf_rejected', 'Cross-origin request rejected');
}

export function cleanRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]+/g, '');
}

/** Characters per recovery code: 16 from a 32-letter alphabet = 80 bits (EXT-5; was 8 = 40 bits). */
const RECOVERY_CHARS = 16;

/**
 * Recovery codes (EXT-5): 80 random bits each, shown once as XXXX-XXXX-XXXX-XXXX. 256 is a
 * multiple of the 32-letter alphabet, so `byte % 32` is unbiased.
 */
export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const bytes = randomBytes(RECOVERY_CHARS);
    let chars = '';
    for (let i = 0; i < RECOVERY_CHARS; i++) {
      chars += RECOVERY_ALPHABET[bytes[i]! % RECOVERY_ALPHABET.length];
    }
    const formatted = chars.match(/.{4}/g)!.join('-');
    if (!seen.has(formatted)) {
      seen.add(formatted);
      codes.push(formatted);
    }
  }
  return codes;
}

/**
 * What is stored for a recovery code: SHA-256 over a version label, the user id and the cleaned
 * code, so the same code never hashes alike for two users and no shared table can be precomputed.
 * With 80 random bits per code a fast hash is enough; the plain code is never stored.
 */
export function recoveryCodeHash(userId: string, code: string): string {
  return sha256(`nigafiy-recovery-v2:${userId}:${cleanRecoveryCode(code)}`);
}

/** Hashes a code may be stored under: the current one, and the 8-character codes issued before EXT-5. */
function recoveryCandidateHashes(userId: string, code: string): string[] {
  const clean = cleanRecoveryCode(code);
  const out = [recoveryCodeHash(userId, code)];
  if (clean.length === 8) out.push(...new Set([sha256(clean), sha256(code.trim().toUpperCase()), sha256(code.trim())]));
  return out;
}

interface MfaSubject {
  userId: string;
  email: string;
  organizationId: string;
  tokenId: string | null;
  viaToken: boolean;
  attempts: number;
  /** The MFA step follows an SSO sign-in: the session it ends in is pinned to that provider. */
  ssoProviderId: string | null;
}

async function resolveMfaSubject(req: Request, mfaToken?: string): Promise<MfaSubject> {
  if (mfaToken) {
    const { rows } = await systemPool.query<{
      token_id: string;
      user_id: string;
      email: string;
      organization_id: string | null;
      attempts: number;
      sso_provider_id: string | null;
    }>(
      `SELECT t.id AS token_id, u.id AS user_id, u.email, t.attempts, t.sso_provider_id,
              coalesce(t.organization_id, (SELECT m.organization_id FROM memberships m WHERE m.user_id = u.id AND m.status = 'active' ORDER BY m.created_at LIMIT 1)) AS organization_id
         FROM auth_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.purpose = 'mfa_enroll' AND t.used_at IS NULL AND t.expires_at > now()`,
      [sha256(mfaToken)],
    );
    const row = rows[0];
    if (!row || !row.organization_id || row.attempts >= 5) {
      throw new AppError(401, 'invalid_mfa_token', 'MFA setup session expired or invalid. Sign in again.');
    }
    return {
      userId: row.user_id,
      email: row.email,
      organizationId: row.organization_id,
      tokenId: row.token_id,
      viaToken: true,
      attempts: row.attempts,
      ssoProviderId: row.sso_provider_id,
    };
  }

  const sessionToken = readCookie(req, SESSION_COOKIE);
  if (!sessionToken) throw new AppError(401, 'unauthenticated', 'Sign in required');
  const { rows } = await systemPool.query<{
    user_id: string;
    email: string;
    organization_id: string;
    role: Role | null;
    status: string | null;
  }>(
    `SELECT u.id AS user_id, u.email, s.active_organization_id AS organization_id, m.role, m.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.user_id = s.user_id AND m.organization_id = s.active_organization_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(sessionToken)],
  );
  const row = rows[0];
  if (!row) throw new AppError(401, 'unauthenticated', 'Session expired, sign in again');
  if (!row.role || row.status !== 'active') throw new AppError(403, 'forbidden', 'You are no longer an active member of this organization');
  return {
    userId: row.user_id,
    email: row.email,
    organizationId: row.organization_id,
    tokenId: null,
    viaToken: false,
    attempts: 0,
    ssoProviderId: null,
  };
}

mfaRouter.post('/login/mfa', mfaLimiter, async (req, res) => {
  requireCsrfHeader(req);
  const body = parse(
    z.object({
      mfa_token: z.string().min(10).max(200),
      code: z.string().trim().min(6).max(32),
    }),
    req.body,
  );

  const tokenRes = await systemPool.query<{
    id: string;
    user_id: string;
    organization_id: string | null;
    attempts: number;
    sso_provider_id: string | null;
  }>(
    `SELECT id, user_id, organization_id, attempts, sso_provider_id
       FROM auth_tokens
      WHERE token_hash = $1 AND purpose = 'mfa_login' AND used_at IS NULL AND expires_at > now()`,
    [sha256(body.mfa_token)],
  );
  const tokenRow = tokenRes.rows[0];
  if (!tokenRow || tokenRow.attempts >= 5) {
    throw new AppError(401, 'invalid_mfa_token', 'Verification session expired or invalid. Sign in again.');
  }

  const userRes = await systemPool.query<{
    id: string;
    email: string;
    mfa_secret_enc: string | null;
    mfa_last_step: string | null;
    mfa_failed_attempts: number;
    mfa_locked_until: Date | null;
  }>(
    `SELECT id, email, mfa_secret_enc, mfa_last_step::text AS mfa_last_step, mfa_failed_attempts, mfa_locked_until
       FROM users WHERE id = $1`,
    [tokenRow.user_id],
  );
  const user = userRes.rows[0];
  if (!user || !user.mfa_secret_enc) {
    throw new AppError(401, 'invalid_mfa_token', 'Multi-factor authentication is not configured');
  }
  if (user.mfa_locked_until && user.mfa_locked_until.getTime() > Date.now()) {
    throw new AppError(429, 'mfa_locked', 'Too many failed verification codes. Try again in 15 minutes.');
  }

  const membershipRes = await systemPool.query<{ organization_id: string }>(
    `SELECT organization_id FROM memberships
      WHERE user_id = $1 AND status = 'active'
      ORDER BY (organization_id = $2) DESC, created_at LIMIT 1`,
    [user.id, tokenRow.organization_id],
  );
  const orgId = membershipRes.rows[0]?.organization_id;
  if (!orgId || (tokenRow.sso_provider_id && orgId !== tokenRow.organization_id)) {
    throw new AppError(403, 'account_deactivated', 'Your account has been deactivated in this organization');
  }

  const secret = decryptSecret(user.mfa_secret_enc);
  const lastStep = user.mfa_last_step !== null ? BigInt(user.mfa_last_step) : null;
  const compactCode = body.code.replace(/\s+/g, '');
  const matchedStep = verifyTotp(secret, compactCode, Date.now(), lastStep);

  let usedRecoveryCodeId: string | null = null;
  if (matchedStep === null) {
    const candidateHashes = recoveryCandidateHashes(user.id, body.code);
    const recRes = await systemPool.query<{ id: string }>(
      `SELECT id FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL AND code_hash = ANY($2) LIMIT 1`,
      [user.id, candidateHashes],
    );
    usedRecoveryCodeId = recRes.rows[0]?.id ?? null;
  }

  if (matchedStep === null && !usedRecoveryCodeId) {
    await withSystem(async (db) => {
      await db.query(`UPDATE auth_tokens SET attempts = attempts + 1 WHERE id = $1`, [tokenRow.id]);
      await db.query(
        `UPDATE users
            SET mfa_failed_attempts = mfa_failed_attempts + 1,
                mfa_locked_until = CASE WHEN mfa_failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE mfa_locked_until END
          WHERE id = $1`,
        [user.id],
      );
    });
    throw new AppError(401, 'invalid_mfa_code', 'Invalid verification or recovery code');
  }

  // One-time use is enforced by the UPDATEs themselves (EXT-5): two requests racing with the same
  // sign-in token, TOTP step or recovery code cannot both succeed; the loser is refused and nothing
  // of it is kept.
  await withSystem(async (db) => {
    const tok = await db.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [tokenRow.id]);
    if (tok.rowCount !== 1) throw new AppError(401, 'invalid_mfa_token', 'Verification session expired or invalid. Sign in again.');
    if (matchedStep !== null) {
      const upd = await db.query(
        `UPDATE users
            SET mfa_failed_attempts = 0, mfa_locked_until = NULL, mfa_last_step = $2, last_login_at = now()
          WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)`,
        [user.id, matchedStep.toString()],
      );
      if (upd.rowCount !== 1) throw new AppError(401, 'invalid_mfa_code', 'Invalid verification or recovery code');
    } else if (usedRecoveryCodeId) {
      const used = await db.query(`UPDATE user_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [usedRecoveryCodeId]);
      if (used.rowCount !== 1) throw new AppError(401, 'invalid_mfa_code', 'Invalid verification or recovery code');
      await db.query(
        `UPDATE users SET mfa_failed_attempts = 0, mfa_locked_until = NULL, last_login_at = now() WHERE id = $1`,
        [user.id],
      );
    }
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, metadata, ip)
       VALUES ($1,$2,$3,'auth.login_mfa',$4,$5)`,
      [
        orgId,
        user.id,
        user.email,
        JSON.stringify({ method: matchedStep !== null ? 'totp' : 'recovery_code' }),
        req.ip ?? null,
      ],
    );
  });

  await createSession(res, req, user.id, orgId, tokenRow.sso_provider_id);
  res.json({ ok: true });
});

mfaRouter.post('/mfa/setup', mfaLimiter, async (req, res) => {
  requireCsrfHeader(req);
  const body = parse(z.object({ mfa_token: z.string().min(10).max(200).optional() }), req.body ?? {});
  const subject = await resolveMfaSubject(req, body.mfa_token);

  if (!subject.viaToken) {
    const existing = await systemPool.query<{ mfa_secret_enc: string | null }>(
      `SELECT mfa_secret_enc FROM users WHERE id = $1`,
      [subject.userId],
    );
    if (existing.rows[0] && existing.rows[0].mfa_secret_enc !== null) {
      throw new AppError(409, 'mfa_already_enabled', 'Disable two-factor authentication before configuring a new secret');
    }
  }

  const secret = newTotpSecret();
  await systemPool.query(`UPDATE users SET mfa_pending_secret_enc = $2 WHERE id = $1`, [
    subject.userId,
    encryptSecret(secret),
  ]);

  res.json({
    secret,
    otpauth_uri: otpauthUri(secret, subject.email),
  });
});

mfaRouter.post('/mfa/confirm', mfaLimiter, async (req, res) => {
  requireCsrfHeader(req);
  const body = parse(
    z.object({
      code: z.string().trim().min(6).max(16),
      mfa_token: z.string().min(10).max(200).optional(),
    }),
    req.body,
  );
  const subject = await resolveMfaSubject(req, body.mfa_token);

  const userRes = await systemPool.query<{
    mfa_pending_secret_enc: string | null;
    mfa_last_step: string | null;
  }>(
    `SELECT mfa_pending_secret_enc, mfa_last_step::text AS mfa_last_step FROM users WHERE id = $1`,
    [subject.userId],
  );
  const user = userRes.rows[0];
  if (!user || !user.mfa_pending_secret_enc) {
    throw new AppError(400, 'mfa_not_started', 'Start MFA setup first');
  }

  const secret = decryptSecret(user.mfa_pending_secret_enc);
  const lastStep = user.mfa_last_step !== null ? BigInt(user.mfa_last_step) : null;
  const matchedStep = verifyTotp(secret, body.code.replace(/\s+/g, ''), Date.now(), lastStep);
  if (matchedStep === null) {
    if (subject.viaToken && subject.tokenId) {
      await systemPool.query(`UPDATE auth_tokens SET attempts = attempts + 1 WHERE id = $1`, [subject.tokenId]);
    }
    throw new AppError(400, 'invalid_mfa_code', 'The verification code is incorrect');
  }

  const recoveryCodes = generateRecoveryCodes(8);

  await withSystem(async (db) => {
    await db.query(
      `UPDATE users
          SET mfa_secret_enc = mfa_pending_secret_enc,
              mfa_pending_secret_enc = NULL,
              mfa_enabled_at = now(),
              mfa_last_step = $2,
              mfa_failed_attempts = 0,
              mfa_locked_until = NULL,
              last_login_at = CASE WHEN $3 THEN now() ELSE last_login_at END
        WHERE id = $1`,
      [subject.userId, matchedStep.toString(), subject.viaToken],
    );
    await db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [subject.userId]);
    for (const c of recoveryCodes) {
      await db.query(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
        subject.userId,
        recoveryCodeHash(subject.userId, c),
      ]);
    }
    if (subject.tokenId) {
      await db.query(`UPDATE auth_tokens SET used_at = now() WHERE id = $1`, [subject.tokenId]);
    }
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, ip)
       VALUES ($1,$2,$3,'auth.mfa_enabled','user',$4,$5)`,
      [subject.organizationId, subject.userId, subject.email, subject.userId, req.ip ?? null],
    );
  });

  if (subject.viaToken) {
    await createSession(res, req, subject.userId, subject.organizationId, subject.ssoProviderId);
  }

  res.json({ ok: true, recovery_codes: recoveryCodes });
});

mfaRouter.post('/mfa/disable', requireSession, async (req, res) => {
  const ctx = req.auth!;
  const body = parse(z.object({ password: z.string().min(1).max(200) }), req.body);

  const policyRes = await systemPool.query<{ mfa_required: string; role: Role }>(
    `SELECT o.mfa_required, m.role
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.status = 'active'`,
    [ctx.userId],
  );
  const policyRequiresMfa = policyRes.rows.some(
    (r) => r.mfa_required === 'all' || (r.mfa_required === 'admins' && (r.role === 'owner' || r.role === 'admin')),
  );
  if (policyRequiresMfa) {
    throw new AppError(409, 'mfa_required', 'Your organization requires multi-factor authentication for your role');
  }

  const userRes = await systemPool.query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [ctx.userId],
  );
  const user = userRes.rows[0];
  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    throw new AppError(401, 'invalid_password', 'Password is incorrect');
  }

  await withSystem(async (db) => {
    await db.query(
      `UPDATE users
          SET mfa_secret_enc = NULL,
              mfa_enabled_at = NULL,
              mfa_pending_secret_enc = NULL,
              mfa_last_step = NULL,
              mfa_failed_attempts = 0,
              mfa_locked_until = NULL
        WHERE id = $1`,
      [ctx.userId],
    );
    await db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [ctx.userId]);
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, ip)
       VALUES ($1,$2,$3,'auth.mfa_disabled','user',$4,$5)`,
      [ctx.organizationId, ctx.userId, ctx.userEmail, ctx.userId, req.ip ?? null],
    );
  });

  res.json({ ok: true });
});

mfaRouter.post('/mfa/recovery-codes', requireSession, async (req, res) => {
  const ctx = req.auth!;
  const body = parse(z.object({ password: z.string().min(1).max(200) }), req.body);

  const userRes = await systemPool.query<{ password_hash: string; mfa_secret_enc: string | null }>(
    `SELECT password_hash, mfa_secret_enc FROM users WHERE id = $1`,
    [ctx.userId],
  );
  const user = userRes.rows[0];
  if (!user || !user.mfa_secret_enc) {
    throw new AppError(409, 'mfa_not_enabled', 'Multi-factor authentication is not enabled');
  }
  if (!(await verifyPassword(body.password, user.password_hash))) {
    throw new AppError(401, 'invalid_password', 'Password is incorrect');
  }

  const recoveryCodes = generateRecoveryCodes(8);
  await withSystem(async (db) => {
    await db.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [ctx.userId]);
    for (const c of recoveryCodes) {
      await db.query(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
        ctx.userId,
        recoveryCodeHash(ctx.userId, c),
      ]);
    }
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, ip)
       VALUES ($1,$2,$3,'auth.mfa_recovery_codes','user',$4,$5)`,
      [ctx.organizationId, ctx.userId, ctx.userEmail, ctx.userId, req.ip ?? null],
    );
  });

  res.json({ recovery_codes: recoveryCodes });
});
