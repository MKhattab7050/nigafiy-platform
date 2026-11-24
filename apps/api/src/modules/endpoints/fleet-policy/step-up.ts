import type { Request } from 'express';
import { decryptSecret, hmacSha256, safeEqual, sha256 } from '../../../common/crypto.ts';
import { AppError, type AuthContext } from '../../../common/http.ts';
import { env } from '../../../config/env.ts';
import { systemPool, withSystem } from '../../../infrastructure/db.ts';
import { verifyTotp } from '../../auth/totp.ts';

// MFA to connect (a group's policy may require it): the operator proves the TOTP factor again right
// before a session, and gets a short-lived step-up token for the session request. Nothing is stored:
// the token is an HMAC over the user, the organization, the sign-in session and the expiry, with a
// key derived from APP_ENCRYPTION_KEY. Codes are checked like at sign-in: through systemPool (the app
// role has no grants on users), a code is used once (mfa_last_step), and 5 wrong codes lock the
// factor for 15 minutes (mfa_failed_attempts / mfa_locked_until, shared with sign-in).

export const STEP_UP_TTL_SECONDS = 300;

const key = (): string => sha256(`nigafiy-fleet-step-up|${env.APP_ENCRYPTION_KEY}`);
const body = (ctx: Pick<AuthContext, 'userId' | 'organizationId' | 'sessionId'>, exp: number) => `${ctx.userId}|${ctx.organizationId}|${sha256(ctx.sessionId)}|${exp}`;

export function issueStepUpToken(ctx: Pick<AuthContext, 'userId' | 'organizationId' | 'sessionId'>, nowMs = Date.now()): { token: string; expires_at: string } {
  const exp = Math.floor(nowMs / 1000) + STEP_UP_TTL_SECONDS;
  return { token: `fsu1.${exp}.${hmacSha256(key(), body(ctx, exp))}`, expires_at: new Date(exp * 1000).toISOString() };
}

/** 'valid' only for a token issued to this user, organization and sign-in session, not expired. */
export function checkStepUpToken(token: string | undefined, ctx: Pick<AuthContext, 'userId' | 'organizationId' | 'sessionId'>, nowMs = Date.now()): 'valid' | 'invalid' | 'absent' {
  if (!token) return 'absent';
  const m = /^fsu1\.(\d{10})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return 'invalid';
  const exp = Number(m[1]);
  if (exp * 1000 <= nowMs || exp * 1000 > nowMs + (STEP_UP_TTL_SECONDS + 5) * 1000) return 'invalid';
  return safeEqual(m[2]!, hmacSha256(key(), body(ctx, exp))) ? 'valid' : 'invalid';
}

export async function operatorHasMfa(userId: string): Promise<boolean> {
  const r = await systemPool.query<{ on: boolean }>(`SELECT mfa_secret_enc IS NOT NULL AS on FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.on === true;
}

/** POST /fleet/step-up: checks the TOTP code and returns a step-up token. Audited either way. */
export async function stepUp(req: Request, ctx: AuthContext, code: string): Promise<{ step_up_token: string; expires_at: string }> {
  const r = await systemPool.query<{ mfa_secret_enc: string | null; mfa_last_step: string | null; mfa_locked_until: Date | null }>(
    `SELECT mfa_secret_enc, mfa_last_step::text AS mfa_last_step, mfa_locked_until FROM users WHERE id = $1`,
    [ctx.userId],
  );
  const user = r.rows[0];
  if (!user?.mfa_secret_enc) throw new AppError(409, 'policy_mfa_not_enrolled', 'Set up an authenticator app in your account first');
  if (user.mfa_locked_until && user.mfa_locked_until.getTime() > Date.now()) {
    throw new AppError(429, 'mfa_locked', 'Too many failed verification codes. Try again in 15 minutes.');
  }
  const lastStep = user.mfa_last_step !== null ? BigInt(user.mfa_last_step) : null;
  const step = verifyTotp(decryptSecret(user.mfa_secret_enc), code.replace(/\s+/g, ''), Date.now(), lastStep);
  const auditRow = (db: { query: (q: string, v: unknown[]) => Promise<unknown> }, action: string, metadata: Record<string, unknown>) =>
    db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
       VALUES ($1,$2,$3,$4,'user',$5,$6,$7)`,
      [ctx.organizationId, ctx.userId, ctx.userEmail, action, ctx.userId, JSON.stringify(metadata), req.ip ?? null],
    );
  if (step === null) {
    // A wrong code, or one already used (replay): both count towards the lockout.
    const locked = await withSystem(async (db) => {
      const u = await db.query<{ locked: boolean }>(
        `UPDATE users
            SET mfa_failed_attempts = mfa_failed_attempts + 1,
                mfa_locked_until = CASE WHEN mfa_failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE mfa_locked_until END
          WHERE id = $1 RETURNING mfa_locked_until IS NOT NULL AND mfa_locked_until > now() AS locked`,
        [ctx.userId],
      );
      const isLocked = u.rows[0]?.locked === true;
      await auditRow(db, 'fleet.policy_mfa_failed', { locked: isLocked });
      return isLocked;
    });
    if (locked) throw new AppError(429, 'mfa_locked', 'Too many failed verification codes. Try again in 15 minutes.');
    throw new AppError(401, 'invalid_mfa_code', 'Invalid verification code');
  }
  await withSystem(async (db) => {
    await db.query(`UPDATE users SET mfa_failed_attempts = 0, mfa_locked_until = NULL, mfa_last_step = $2 WHERE id = $1`, [ctx.userId, step.toString()]);
    await auditRow(db, 'fleet.policy_mfa_verified', { ttl_seconds: STEP_UP_TTL_SECONDS });
  });
  const t = issueStepUpToken(ctx);
  return { step_up_token: t.token, expires_at: t.expires_at };
}
