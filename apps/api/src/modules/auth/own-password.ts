import type { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { hashPassword, sha256, verifyPassword } from '../../common/crypto.ts';
import { AppError, auth, parse } from '../../common/http.ts';
import { isWebOrigin } from '../../config/env.ts';
import { type Db, systemPool, withSystem } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { cleanRecoveryCode, generateRecoveryCodes } from './mfa.ts';
import { requireSession } from './session.ts';

/**
 * UX review item 6: the owner of an installed copy chooses their own password.
 *
 * The desktop app creates the first account itself (local-stack.cjs signIn) with an address like
 * owner-1a2b3c4d@nigafiy.local and a random password that only the desktop knows. While a person has
 * not chosen a password for that account, the web app offers "Set your own password"; doing so
 * also issues one-time recovery codes that reset the password from the sign-in page.
 *
 * The desktop keeps signing in on its own: the first time a person replaces the auto-created
 * password, its hash moves to desktop_password_hash (with the address it was issued for), which
 * only POST /auth/login/desktop accepts. The owner's own password is the only one /auth/login takes.
 */

/** The address the desktop app gives the account it creates. */
export const LOCAL_OWNER_EMAIL_RE = '^owner-[0-9a-f]{8}@nigafiy\\.local$';

/** SQL (over users) that is true while the account is the desktop's auto-created one with its random password. */
export const NEEDS_OWN_PASSWORD_SQL = `(password_set_by_owner_at IS NULL AND email ~ '${LOCAL_OWNER_EMAIL_RE}')`;

/**
 * SET items for any UPDATE that replaces users.password_hash with one a person chose: stamps the
 * time and, the first time on an auto-created account, keeps the desktop app's credential. Postgres
 * evaluates every SET expression against the row as it was, so password_hash here is the old hash.
 */
export const PERSON_CHOSE_PASSWORD_SQL = `
  password_set_by_owner_at = now(),
  desktop_login_email   = CASE WHEN ${NEEDS_OWN_PASSWORD_SQL} THEN email ELSE desktop_login_email END,
  desktop_password_hash = CASE WHEN ${NEEDS_OWN_PASSWORD_SQL} THEN password_hash ELSE desktop_password_hash END`;

/** How many password recovery codes are issued at a time. */
export const ACCOUNT_RECOVERY_CODE_COUNT = 10;

/**
 * Stored form of a password recovery code. The label differs from the MFA recovery codes
 * (mfa.ts recoveryCodeHash) so a code of one kind never matches the other: MFA codes stand in for
 * the second factor, these for the first, and one leaked list must not defeat both.
 */
export function accountRecoveryCodeHash(userId: string, code: string): string {
  return sha256(`nigafiy-account-recovery-v1:${userId}:${cleanRecoveryCode(code)}`);
}

async function issueRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes(ACCOUNT_RECOVERY_CODE_COUNT);
  await db.query(`DELETE FROM account_recovery_codes WHERE user_id = $1`, [userId]);
  for (const c of codes) {
    await db.query(`INSERT INTO account_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, accountRecoveryCodeHash(userId, c)]);
  }
  return codes;
}

function requireCsrfHeader(req: import('express').Request): void {
  if (req.headers['x-ld-csrf'] !== '1') throw new AppError(403, 'csrf_rejected', 'Missing CSRF header');
  const origin = req.headers.origin;
  if (origin && !isWebOrigin(origin)) throw new AppError(403, 'csrf_rejected', 'Cross-origin request rejected');
}

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(10, 'Use at least 10 characters').max(200);

/** Mounted by routes.ts, which owns the sign-in rate limiters these routes share with /login. */
export function mountOwnPasswordRoutes(router: Router, limiters: { credential: RequestHandler; account: RequestHandler }): void {
  /** First run of an installed copy: choose an address (optional) and a password; returns recovery codes once. */
  router.post('/own-password', requireSession, async (req, res) => {
    const ctx = auth(req);
    const body = parse(z.object({ email: email.optional(), password }).strict(), req.body);
    const newHash = await hashPassword(body.password);

    const result = await withSystem(async (db) => {
      const userRes = await db.query<{ email: string; needs: boolean }>(
        `SELECT email, ${NEEDS_OWN_PASSWORD_SQL} AS needs FROM users WHERE id = $1 FOR UPDATE`,
        [ctx.userId],
      );
      const user = userRes.rows[0];
      if (!user?.needs) {
        throw new AppError(409, 'own_password_already_set', 'This account already has a password you chose. Change it in Settings → Account.');
      }
      const nextEmail = body.email ?? user.email;
      if (nextEmail !== user.email.toLowerCase()) {
        if (nextEmail.endsWith('@nigafiy.local')) {
          throw new AppError(400, 'validation_error', 'Use your own email address, or leave the field empty to keep the current one', [
            { path: 'email', message: 'Use your own email address' },
          ]);
        }
        const taken = await db.query(
          `SELECT 1 FROM users WHERE id <> $1 AND (lower(email) = $2 OR lower(desktop_login_email) = $2)`,
          [ctx.userId, nextEmail],
        );
        if (taken.rowCount) throw new AppError(409, 'email_in_use', 'An account with this email already exists');
      }
      await db.query(`UPDATE users SET ${PERSON_CHOSE_PASSWORD_SQL}, password_hash = $2, password_changed_at = now(), email = $3 WHERE id = $1`, [
        ctx.userId,
        newHash,
        nextEmail,
      ]);
      const codes = await issueRecoveryCodes(db, ctx.userId);
      await db.query(
        `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
         VALUES ($1,$2,$3,'auth.own_password_set','user',$4,$5,$6)`,
        [ctx.organizationId, ctx.userId, nextEmail, ctx.userId, JSON.stringify({ email_changed: nextEmail !== user.email.toLowerCase() }), req.ip ?? null],
      );
      return { email: nextEmail, codes };
    });

    logger.info({ user_id: ctx.userId }, 'owner chose their own password');
    res.json({ ok: true, email: result.email, recovery_codes: result.codes });
  });

  /** A new set of password recovery codes (the old ones stop working). Needs the current password. */
  router.post('/account-recovery-codes', requireSession, async (req, res) => {
    const ctx = auth(req);
    const body = parse(z.object({ password: z.string().min(1).max(200) }).strict(), req.body);
    const userRes = await systemPool.query<{ password_hash: string; needs: boolean }>(
      `SELECT password_hash, ${NEEDS_OWN_PASSWORD_SQL} AS needs FROM users WHERE id = $1`,
      [ctx.userId],
    );
    const user = userRes.rows[0];
    if (!user || user.needs) throw new AppError(409, 'own_password_not_set', 'Set your own password first');
    if (!(await verifyPassword(body.password, user.password_hash))) throw new AppError(401, 'invalid_password', 'Password is incorrect');
    const codes = await withSystem(async (db) => {
      const issued = await issueRecoveryCodes(db, ctx.userId);
      await db.query(
        `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, ip)
         VALUES ($1,$2,$3,'auth.account_recovery_codes','user',$4,$5)`,
        [ctx.organizationId, ctx.userId, ctx.userEmail, ctx.userId, req.ip ?? null],
      );
      return issued;
    });
    res.json({ recovery_codes: codes });
  });

  /**
   * Sign-in page, "Use a recovery code": email + one unused code + a new password. Each code works
   * once. Signs out every session; the browser then signs in with the new password the normal way,
   * so two-factor sign-in still applies. The desktop app's own credential is kept: the computer
   * Nigafiy runs on stays reachable by the person who has it.
   */
  router.post('/recover', limiters.credential, limiters.account, async (req, res) => {
    requireCsrfHeader(req);
    const body = parse(
      z.object({ email, code: z.string().trim().min(8).max(40), new_password: password }).strict(),
      req.body,
    );
    const userRes = await systemPool.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE lower(email) = $1`, [body.email]);
    const user = userRes.rows[0];
    const codeRes = user
      ? await systemPool.query<{ id: string }>(
          `SELECT id FROM account_recovery_codes WHERE user_id = $1 AND used_at IS NULL AND code_hash = $2`,
          [user.id, accountRecoveryCodeHash(user.id, body.code)],
        )
      : null;
    const codeId = codeRes?.rows[0]?.id;
    if (!user || !codeId) {
      logger.warn({ ip: req.ip, account: sha256(body.email).slice(0, 16), known: Boolean(user) }, 'failed password recovery');
      throw new AppError(401, 'invalid_recovery_code', 'Email or recovery code is incorrect, or the code was already used');
    }

    const newHash = await hashPassword(body.new_password);
    const left = await withSystem(async (db) => {
      // One-time use is enforced by this UPDATE: two requests racing with one code cannot both win.
      const used = await db.query(`UPDATE account_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [codeId]);
      if (used.rowCount !== 1) throw new AppError(401, 'invalid_recovery_code', 'Email or recovery code is incorrect, or the code was already used');
      await db.query(`UPDATE users SET ${PERSON_CHOSE_PASSWORD_SQL}, password_hash = $2, password_changed_at = now() WHERE id = $1`, [user.id, newHash]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
      await db.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
      const remaining = Number(
        (await db.query<{ n: string }>(`SELECT count(*) AS n FROM account_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [user.id])).rows[0]!.n,
      );
      const org = await db.query<{ organization_id: string }>(
        `SELECT organization_id FROM memberships WHERE user_id = $1 ORDER BY (status = 'active') DESC, created_at LIMIT 1`,
        [user.id],
      );
      if (org.rows[0]) {
        await db.query(
          `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
           VALUES ($1,$2,$3,'auth.password_recovered','user',$4,$5,$6)`,
          [org.rows[0].organization_id, user.id, user.email, user.id, JSON.stringify({ codes_left: remaining }), req.ip ?? null],
        );
      }
      return remaining;
    });
    res.json({ ok: true, codes_left: left });
  });
}
