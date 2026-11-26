import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { generateRecoveryCodes } from '../src/modules/auth/mfa.ts';
import { CSRF, app } from './helpers.ts';

/**
 * UX review item 6: the desktop's auto-created owner account (owner-<hex>@nigafiy.local, random
 * password) can get a password the person chose, plus one-time recovery codes, and the desktop
 * keeps signing in with the credential it stored.
 */

const MINE = 'my own password 123';

/** What local-stack.cjs signIn() does on first run: register owner-<8 hex>@nigafiy.local with a random password. */
async function desktopAccount() {
  const desktop = { email: `owner-${randomBytes(4).toString('hex')}@nigafiy.local`, password: randomBytes(24).toString('base64url') };
  const agent = request.agent(app);
  const reg = await agent.post('/api/v1/auth/register').set(CSRF).send({ ...desktop, display_name: 'Me', organization_name: 'My home', site_name: 'Home' });
  expect(reg.status).toBe(201);
  return { agent, desktop };
}

const realEmail = () => `me-${randomBytes(4).toString('hex')}@example.test`;
const login = (email: string, password: string) => request(app).post('/api/v1/auth/login').set(CSRF).send({ email, password });
const desktopLogin = (email: string, password: string) => request(app).post('/api/v1/auth/login/desktop').set(CSRF).send({ email, password });
const recover = (email: string, code: string, new_password: string) => request(app).post('/api/v1/auth/recover').set(CSRF).send({ email, code, new_password });

describe('owner sets their own password on an installed copy', () => {
  it('flags only the auto-created local account', async () => {
    const { agent } = await desktopAccount();
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.user.needs_own_password).toBe(true);
    expect(me.body.user.recovery_codes_left).toBe(0);

    const other = request.agent(app);
    await other.post('/api/v1/auth/register').set(CSRF).send({ email: realEmail(), password: MINE, display_name: 'x', organization_name: 'x org' });
    expect((await other.get('/api/v1/auth/me')).body.user.needs_own_password).toBe(false);
    // Only the auto-created account may set a password without knowing the current one.
    const refused = await other.post('/api/v1/auth/own-password').set(CSRF).send({ password: 'something else 1' });
    expect(refused.status).toBe(409);
  });

  it('sets email and password once, returns 10 recovery codes, and keeps the desktop signing in', async () => {
    const { agent, desktop } = await desktopAccount();
    const email = realEmail();
    const short = await agent.post('/api/v1/auth/own-password').set(CSRF).send({ email, password: 'short' });
    expect(short.status).toBe(400);

    const set = await agent.post('/api/v1/auth/own-password').set(CSRF).send({ email: email.toUpperCase(), password: MINE });
    expect(set.status).toBe(200);
    expect(set.body.email).toBe(email);
    expect(set.body.recovery_codes).toHaveLength(10);
    expect(new Set(set.body.recovery_codes).size).toBe(10);

    // Only hashes are stored.
    const stored = await systemPool.query<{ code_hash: string }>(
      `SELECT c.code_hash FROM account_recovery_codes c JOIN users u ON u.id = c.user_id WHERE u.email = $1`,
      [email],
    );
    expect(stored.rowCount).toBe(10);
    for (const row of stored.rows) expect(set.body.recovery_codes).not.toContain(row.code_hash);

    // The current session keeps working; the banner is gone; a second call is refused.
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email, needs_own_password: false, recovery_codes_left: 10 });
    expect((await agent.post('/api/v1/auth/own-password').set(CSRF).send({ password: 'another password 1' })).status).toBe(409);

    // The person signs in with what they chose, from anywhere; the desktop's random password no longer works there.
    expect((await login(email, MINE)).status).toBe(200);
    expect((await login(desktop.email, desktop.password)).status).toBe(401);
    expect((await login(email, desktop.password)).status).toBe(401);

    // The desktop app signs in with its stored credential through its own route, and only there.
    const d = await desktopLogin(desktop.email, desktop.password);
    expect(d.status).toBe(200);
    expect(d.body.ok).toBe(true);
    expect(((d.headers['set-cookie'] as unknown as string[] | undefined) ?? []).some((c: string) => c.startsWith('ld_session='))).toBe(true);
    expect((await desktopLogin(desktop.email, MINE)).status).toBe(401);
    expect((await desktopLogin(email, MINE)).status).toBe(401);

    // Changing the password later keeps the desktop credential too.
    expect((await agent.post('/api/v1/auth/password').set(CSRF).send({ current_password: MINE, new_password: 'newer password 99' })).status).toBe(200);
    expect((await desktopLogin(desktop.email, desktop.password)).status).toBe(200);
  });

  it('keeps the local address when no email is given, and refuses a taken or another local one', async () => {
    const taken = request.agent(app);
    const takenEmail = realEmail();
    await taken.post('/api/v1/auth/register').set(CSRF).send({ email: takenEmail, password: MINE, display_name: 'x', organization_name: 'x org' });

    const { agent, desktop } = await desktopAccount();
    expect((await agent.post('/api/v1/auth/own-password').set(CSRF).send({ email: takenEmail, password: MINE })).status).toBe(409);
    expect((await agent.post('/api/v1/auth/own-password').set(CSRF).send({ email: 'owner-00000000@nigafiy.local', password: MINE })).status).toBe(400);

    const set = await agent.post('/api/v1/auth/own-password').set(CSRF).send({ password: MINE });
    expect(set.status).toBe(200);
    expect(set.body.email).toBe(desktop.email);
    expect((await agent.get('/api/v1/auth/me')).body.user.needs_own_password).toBe(false);
    expect((await login(desktop.email, MINE)).status).toBe(200);
    expect((await desktopLogin(desktop.email, desktop.password)).status).toBe(200);
  });

  it('a recovery code resets the password once; wrong, used or other-account codes are refused', async () => {
    const { agent, desktop } = await desktopAccount();
    const email = realEmail();
    const codes: string[] = (await agent.post('/api/v1/auth/own-password').set(CSRF).send({ email, password: MINE })).body.recovery_codes;

    // Wrong code, unknown account, a code shaped right but never issued: same answer.
    const wrong = await recover(email, generateRecoveryCodes(1)[0]!, 'reset password 1');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_recovery_code');
    expect((await recover(realEmail(), codes[0]!, 'reset password 1')).status).toBe(401);
    // Too short a new password is refused before the code is spent.
    expect((await recover(email, codes[0]!, 'short')).status).toBe(400);

    // Lower case and without dashes is accepted.
    const ok = await recover(email.toUpperCase(), codes[0]!.toLowerCase().replace(/-/g, ''), 'reset password 1');
    expect(ok.status).toBe(200);
    expect(ok.body.codes_left).toBe(9);

    // Every session is signed out; the new password works, the old one does not.
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await login(email, MINE)).status).toBe(401);
    expect((await login(email, 'reset password 1')).status).toBe(200);
    // The desktop app still gets in.
    expect((await desktopLogin(desktop.email, desktop.password)).status).toBe(200);

    // The same code a second time.
    const again = await recover(email, codes[0]!, 'reset password 2');
    expect(again.status).toBe(401);
    expect((await login(email, 'reset password 1')).status).toBe(200);

    // Another code still works.
    expect((await recover(email, codes[1]!, 'reset password 2')).status).toBe(200);
    expect((await login(email, 'reset password 2')).status).toBe(200);

    const audit = await systemPool.query(`SELECT 1 FROM audit_logs a JOIN users u ON u.id = a.user_id WHERE u.email = $1 AND a.action = 'auth.password_recovered'`, [email]);
    expect(audit.rowCount).toBe(2);
  });

  it('a code from another account’s list is refused', async () => {
    const { agent } = await desktopAccount();
    const email = realEmail();
    const codes: string[] = (await agent.post('/api/v1/auth/own-password').set(CSRF).send({ email, password: MINE })).body.recovery_codes;
    const { agent: otherAgent } = await desktopAccount();
    const otherCodes: string[] = (await otherAgent.post('/api/v1/auth/own-password').set(CSRF).send({ email: realEmail(), password: MINE })).body.recovery_codes;
    expect((await recover(email, otherCodes[0]!, 'reset password 1')).status).toBe(401);
    expect(codes).not.toContain(otherCodes[0]);
  });

  it('new codes need the current password and replace the old ones', async () => {
    const { agent } = await desktopAccount();
    expect((await agent.post('/api/v1/auth/account-recovery-codes').set(CSRF).send({ password: 'x' })).status).toBe(409);
    const email = realEmail();
    const first: string[] = (await agent.post('/api/v1/auth/own-password').set(CSRF).send({ email, password: MINE })).body.recovery_codes;
    expect((await agent.post('/api/v1/auth/account-recovery-codes').set(CSRF).send({ password: 'wrong password' })).status).toBe(401);
    const next = await agent.post('/api/v1/auth/account-recovery-codes').set(CSRF).send({ password: MINE });
    expect(next.status).toBe(200);
    expect(next.body.recovery_codes).toHaveLength(10);
    expect((await recover(email, first[0]!, 'reset password 1')).status).toBe(401);
    expect((await recover(email, next.body.recovery_codes[0], 'reset password 1')).status).toBe(200);
  });

  it('recovery needs the CSRF header and sits behind the sign-in rate limiters', async () => {
    expect((await request(app).post('/api/v1/auth/recover').send({ email: realEmail(), code: 'AAAA-AAAA-AAAA-AAAA', new_password: 'whatever 12345' })).status).toBe(403);
    const res = await recover(realEmail(), 'AAAA-AAAA-AAAA-AAAA', 'whatever 12345');
    expect(res.status).toBe(401);
    // express-rate-limit (draft-7 headers): the per-address and per-account limiters of /login apply here too.
    expect(res.headers['ratelimit-policy']).toBeTruthy();
    const d = await desktopLogin(realEmail(), 'whatever');
    expect(d.status).toBe(401);
    expect(d.headers['ratelimit-policy']).toBeTruthy();
  });

  it('desktop sign-in still asks for the second factor when MFA is on', async () => {
    const { agent, desktop } = await desktopAccount();
    await agent.post('/api/v1/auth/own-password').set(CSRF).send({ password: MINE });
    await systemPool.query(`UPDATE users SET mfa_secret_enc = 'x', mfa_enabled_at = now() WHERE email = $1`, [desktop.email]);
    const d = await desktopLogin(desktop.email, desktop.password);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ ok: false, mfa_required: true });
    expect(((d.headers['set-cookie'] as unknown as string[] | undefined) ?? []).some((c: string) => c.startsWith('ld_session=') && !c.startsWith('ld_session=;'))).toBeFalsy();
  });
});
