import net from 'node:net';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/common/crypto.ts';
import { systemPool } from '../src/infrastructure/db.ts';
import { recoveryCodeHash } from '../src/modules/auth/mfa.ts';
import { base32Decode, hotp, timeStep, totp } from '../src/modules/auth/totp.ts';
import { CSRF, type TestAccount, app, newAccount } from './helpers.ts';

/**
 * Account security end to end: MFA replay protection and lockout, member deactivation and
 * reactivation, and password reset (self-service by email and issued by an administrator).
 */

const PASSWORD = 'correct horse battery';

const userId = async (email: string) => (await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email])).rows[0]!.id;
const auditRows = async (orgId: string, action: string) =>
  (await systemPool.query<{ user_id: string | null; target_id: string | null; metadata: Record<string, unknown> | null }>(`SELECT user_id, target_id, metadata FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at`, [orgId, action])).rows;

const login = (agent: ReturnType<typeof request.agent>, email: string, password = PASSWORD) => agent.post('/api/v1/auth/login').set(CSRF).send({ email, password });

/** Enables TOTP for the signed-in account; returns the secret and the recovery codes. */
async function enableMfa(a: TestAccount): Promise<{ secret: string; recovery: string[] }> {
  const setup = await a.agent.post('/api/v1/auth/mfa/setup').set(CSRF).send({});
  expect(setup.status).toBe(200);
  const confirm = await a.agent.post('/api/v1/auth/mfa/confirm').set(CSRF).send({ code: totp(base32Decode(setup.body.secret), Date.now()) });
  expect(confirm.status).toBe(200);
  return { secret: setup.body.secret, recovery: confirm.body.recovery_codes };
}

/** A six-digit code that is certainly wrong right now (not valid for any accepted step). */
function wrongCode(secret: string): string {
  const key = base32Decode(secret);
  const now = timeStep(Date.now());
  const valid = new Set([now - 2n, now - 1n, now, now + 1n, now + 2n].map((s) => hotp(key, s)));
  for (let i = 0; ; i++) {
    const c = String(123456 + i * 7919).padStart(6, '0').slice(-6);
    if (!valid.has(c)) return c;
  }
}

/** Invites a new member with `role` and returns a signed-in agent for them. */
async function addMember(owner: TestAccount, role: 'admin' | 'technician' | 'viewer') {
  const email = `${role}-${Math.random().toString(36).slice(2, 10)}@example.test`;
  const inv = await owner.agent.post('/api/v1/team/invitations').set(CSRF).send({ email, role });
  expect(inv.status).toBe(201);
  const agent = request.agent(app);
  const acc = await agent.post(`/api/v1/auth/invitations/${inv.body.token}/accept`).set(CSRF).send({ display_name: role, password: PASSWORD });
  expect(acc.status).toBe(200);
  expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
  return { email, agent, id: await userId(email) };
}

describe('MFA replay protection and lockout', () => {
  it('accepts each TOTP step once: the enrollment code and a used sign-in code are refused afterwards', async () => {
    const a = await newAccount('mfa-replay');
    const { secret } = await enableMfa(a);
    const key = base32Decode(secret);
    const enrolledStep = (await systemPool.query<{ s: string }>(`SELECT mfa_last_step::text AS s FROM users WHERE lower(email) = $1`, [a.email])).rows[0]!.s;

    const browser = request.agent(app);
    const first = await login(browser, a.email);
    expect(first.body).toMatchObject({ ok: false, mfa_required: true });
    // The code that confirmed enrollment belongs to an already used step.
    const replayEnroll = await browser.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: first.body.mfa_token, code: hotp(key, BigInt(enrolledStep)) });
    expect(replayEnroll.status).toBe(401);
    expect(replayEnroll.body.error.code).toBe('invalid_mfa_code');

    // The next step (accepted as +30 s clock skew) signs in once…
    const next = totp(key, Date.now() + 30_000);
    const ok = await browser.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: first.body.mfa_token, code: next });
    expect(ok.status).toBe(200);
    expect((await browser.get('/api/v1/auth/me')).status).toBe(200);

    // …and is refused on the next sign-in, as is any earlier step.
    const again = request.agent(app);
    const second = await login(again, a.email);
    const replay = await again.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: second.body.mfa_token, code: next });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('invalid_mfa_code');
    const older = await again.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: second.body.mfa_token, code: totp(key, Date.now()) });
    expect(older.status).toBe(401);
    expect((await again.get('/api/v1/auth/me')).status).toBe(401);

    // A sign-in token is single use: after success it cannot open a second session.
    const reuseToken = await request(app).post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: first.body.mfa_token, code: totp(key, Date.now() + 30_000) });
    expect(reuseToken.status).toBe(401);
    expect(reuseToken.body.error.code).toBe('invalid_mfa_token');

    const audits = await auditRows(a.organizationId, 'auth.login_mfa');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ method: 'totp' });
  });

  it('uses each recovery code once', async () => {
    const a = await newAccount('mfa-recovery');
    const { recovery } = await enableMfa(a);
    const b1 = request.agent(app);
    const t1 = await login(b1, a.email);
    expect((await b1.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t1.body.mfa_token, code: recovery[0]!.toLowerCase() })).status).toBe(200);
    const b2 = request.agent(app);
    const t2 = await login(b2, a.email);
    const reused = await b2.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t2.body.mfa_token, code: recovery[0] });
    expect(reused.status).toBe(401);
    expect((await b2.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t2.body.mfa_token, code: recovery[1] })).status).toBe(200);
    expect((await auditRows(a.organizationId, 'auth.login_mfa')).map((r) => r.metadata?.method)).toEqual(['recovery_code', 'recovery_code']);
  });

  it('issues 80-bit recovery codes, stores only per-user hashes, and lets a racing reuse through once (EXT-5)', async () => {
    const a = await newAccount('mfa-recovery-v2');
    const { recovery } = await enableMfa(a);
    expect(recovery).toHaveLength(8);
    for (const c of recovery) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    const uid = await userId(a.email);
    const stored = (await systemPool.query<{ code_hash: string }>(`SELECT code_hash FROM user_recovery_codes WHERE user_id = $1`, [uid])).rows.map((r) => r.code_hash);
    expect(stored).toHaveLength(8);
    expect(stored.join(' ')).not.toMatch(/[A-Z]{4}-/); // never the plain code
    expect(stored).not.toContain(sha256(recovery[0]!.replace(/-/g, ''))); // salted with the user id
    expect(stored).toContain(recoveryCodeHash(uid, recovery[0]!));

    // Two sign-ins race with the same code: exactly one ends in a session.
    const [b1, b2] = [request.agent(app), request.agent(app)];
    const [t1, t2] = await Promise.all([login(b1, a.email), login(b2, a.email)]);
    const results = await Promise.all([
      b1.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t1.body.mfa_token, code: recovery[0] }),
      b2.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t2.body.mfa_token, code: recovery[0] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);

    // An 8-character code issued before EXT-5 keeps working once.
    await systemPool.query(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [uid, sha256('ABCD2345')]);
    const b3 = request.agent(app);
    const t3 = await login(b3, a.email);
    expect((await b3.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t3.body.mfa_token, code: 'abcd-2345' })).status).toBe(200);
    const b4 = request.agent(app);
    const t4 = await login(b4, a.email);
    expect((await b4.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t4.body.mfa_token, code: 'ABCD-2345' })).status).toBe(401);
  });

  it('locks the account for 15 minutes after five wrong codes across sign-in attempts, then lets a correct code in', async () => {
    const a = await newAccount('mfa-lock');
    const { secret } = await enableMfa(a);
    const bad = wrongCode(secret);

    // Three failures on one sign-in and two on another: the counter is per account, not per attempt.
    const b1 = request.agent(app);
    const t1 = (await login(b1, a.email)).body.mfa_token;
    for (let i = 0; i < 3; i++) expect((await b1.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t1, code: bad })).status).toBe(401);
    const b2 = request.agent(app);
    const t2 = (await login(b2, a.email)).body.mfa_token;
    expect((await b2.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t2, code: bad })).status).toBe(401);
    const fifth = await b2.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t2, code: bad });
    expect(fifth.status).toBe(401);

    const state = (await systemPool.query<{ n: number; until: Date | null }>(`SELECT mfa_failed_attempts AS n, mfa_locked_until AS until FROM users WHERE lower(email) = $1`, [a.email])).rows[0]!;
    expect(state.n).toBe(5);
    const minutes = (state.until!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15.1);

    // While locked, even the right code on an existing token is refused, and the password step says so.
    const locked = await b2.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t2, code: totp(base32Decode(secret), Date.now() + 30_000) });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('mfa_locked');
    const pw = await login(request.agent(app), a.email);
    expect(pw.status).toBe(429);
    expect(pw.body.error.code).toBe('mfa_locked');
    expect((await b2.get('/api/v1/auth/me')).status).toBe(401);

    // Fifteen minutes later (the lock moved into the past) a correct code signs in and clears the counter.
    await systemPool.query(`UPDATE users SET mfa_locked_until = now() - interval '1 second' WHERE lower(email) = $1`, [a.email]);
    const b3 = request.agent(app);
    const t3 = (await login(b3, a.email)).body.mfa_token;
    expect((await b3.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t3, code: totp(base32Decode(secret), Date.now() + 30_000) })).status).toBe(200);
    const after = (await systemPool.query<{ n: number; until: Date | null }>(`SELECT mfa_failed_attempts AS n, mfa_locked_until AS until FROM users WHERE lower(email) = $1`, [a.email])).rows[0]!;
    expect(after).toEqual({ n: 0, until: null });
  });

  it('a sign-in token dies after five wrong codes even before the account lock matters', async () => {
    const a = await newAccount('mfa-token');
    const { secret } = await enableMfa(a);
    const b = request.agent(app);
    const t = (await login(b, a.email)).body.mfa_token;
    for (let i = 0; i < 5; i++) await b.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t, code: wrongCode(secret) });
    await systemPool.query(`UPDATE users SET mfa_locked_until = NULL WHERE lower(email) = $1`, [a.email]);
    const res = await b.post('/api/v1/auth/login/mfa').set(CSRF).send({ mfa_token: t, code: totp(base32Decode(secret), Date.now() + 30_000) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_mfa_token');
  });
});

describe('member deactivation and reactivation', () => {
  it('deactivating ends the member’s sessions and blocks sign-in; reactivating restores it; both are audited', async () => {
    const owner = await newAccount('members');
    const member = await addMember(owner, 'technician');
    const ownerId = await userId(owner.email);

    const off = await owner.agent.patch(`/api/v1/team/members/${member.id}`).set(CSRF).send({ status: 'deactivated' });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ status: 'deactivated', role: 'technician' });
    expect(off.body.deactivated_at).toBeTruthy();
    const row = (await systemPool.query<{ deactivated_by: string }>(`SELECT deactivated_by FROM memberships WHERE organization_id = $1 AND user_id = $2`, [owner.organizationId, member.id])).rows[0]!;
    expect(row.deactivated_by).toBe(ownerId);

    expect((await member.agent.get('/api/v1/auth/me')).status).toBe(401);
    const blocked = await login(request.agent(app), member.email);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('account_deactivated');
    // A deactivated member is still listed (so it can be reactivated), after the active ones.
    const team = (await owner.agent.get('/api/v1/team')).body.members as { id: string; status: string }[];
    expect(team.at(-1)).toMatchObject({ id: member.id, status: 'deactivated' });

    const on = await owner.agent.patch(`/api/v1/team/members/${member.id}`).set(CSRF).send({ status: 'active' });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ status: 'active', deactivated_at: null });
    const back = request.agent(app);
    expect((await login(back, member.email)).status).toBe(200);
    expect((await back.get('/api/v1/auth/me')).body.role).toBe('technician');

    const audits = await auditRows(owner.organizationId, 'member.updated');
    expect(audits.map((a) => [a.metadata?.previous_status, a.metadata?.status])).toEqual([
      ['active', 'deactivated'],
      ['deactivated', 'active'],
    ]);
    expect(audits.every((a) => a.user_id === ownerId && a.target_id === member.id)).toBe(true);
  });

  it('guards: no self-deactivation, the last owner stays, admins cannot touch owners, lower roles cannot manage members', async () => {
    const owner = await newAccount('member-guards');
    const ownerId = await userId(owner.email);
    const admin = await addMember(owner, 'admin');
    const tech = await addMember(owner, 'technician');
    const viewer = await addMember(owner, 'viewer');

    const self = await owner.agent.patch(`/api/v1/team/members/${ownerId}`).set(CSRF).send({ status: 'deactivated' });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('cannot_deactivate_self');
    const demoteLast = await owner.agent.patch(`/api/v1/team/members/${ownerId}`).set(CSRF).send({ role: 'admin' });
    expect(demoteLast.status).toBe(409);
    expect(demoteLast.body.error.code).toBe('last_owner');

    expect((await admin.agent.patch(`/api/v1/team/members/${ownerId}`).set(CSRF).send({ status: 'deactivated' })).status).toBe(403);
    expect((await tech.agent.patch(`/api/v1/team/members/${viewer.id}`).set(CSRF).send({ status: 'deactivated' })).status).toBe(403);
    expect((await viewer.agent.patch(`/api/v1/team/members/${tech.id}`).set(CSRF).send({ status: 'deactivated' })).status).toBe(403);
    // An admin may deactivate a technician.
    expect((await admin.agent.patch(`/api/v1/team/members/${tech.id}`).set(CSRF).send({ status: 'deactivated' })).status).toBe(200);

    // Another organization's member is not found here.
    const other = await newAccount('member-guards-other');
    expect((await other.agent.patch(`/api/v1/team/members/${viewer.id}`).set(CSRF).send({ status: 'deactivated' })).status).toBe(404);
    expect((await auditRows(owner.organizationId, 'member.updated')).map((a) => a.target_id)).toEqual([tech.id]);
  });
});

interface Mail {
  to: string[];
  data: string;
}

/** A minimal SMTP relay (no TLS, no login) that records messages. Test double only. */
function fakeSmtp(received: Mail[]) {
  return net.createServer((socket) => {
    let buffer = '';
    let mail: Mail = { to: [], data: '' };
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mail.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(mail);
          mail = { to: [], data: '' };
          socket.write('250 queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'RCPT') mail.to.push(/<(.*)>/.exec(line)?.[1] ?? '');
        if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
}

/** The reset token in a mail body (undoing quoted-printable soft breaks and escapes if present). */
function tokenFrom(mail: Mail): string {
  const body = mail.data.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
  const m = /reset-password\?token=([A-Za-z0-9_%-]+)/.exec(body);
  if (!m) throw new Error('no reset link in the mail');
  return decodeURIComponent(m[1]!);
}

describe('password reset', () => {
  const received: Mail[] = [];
  const server = fakeSmtp(received);
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function mailOrg(label: string) {
    const owner = await newAccount(label);
    const ch = await owner.agent
      .post('/api/v1/notification-channels')
      .set(CSRF)
      .send({ kind: 'email', name: 'Account mail', recipients: ['it@example.test'], min_severity: 'critical', use_for_account_emails: true, smtp: { host: '127.0.0.1', port, security: 'none', from: 'nigafiy@example.test' } });
    expect(ch.status).toBe(201);
    return owner;
  }

  it('self-service: mails a one-hour single-use link, sets the new password, ends sessions, clears an MFA lock, and audits', async () => {
    const owner = await mailOrg('reset-self');
    const other = request.agent(app);
    expect((await login(other, owner.email)).status).toBe(200); // a second session that must end
    await systemPool.query(`UPDATE users SET mfa_failed_attempts = 5, mfa_locked_until = now() + interval '10 minutes' WHERE lower(email) = $1`, [owner.email]);

    const before = received.length;
    // Unknown addresses get the same answer and no mail (no account enumeration).
    const unknown = await request(app).post('/api/v1/auth/forgot-password').set(CSRF).send({ email: 'nobody-here@example.test' });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ ok: true });
    expect(received.length).toBe(before);

    const asked = await request(app).post('/api/v1/auth/forgot-password').set(CSRF).send({ email: owner.email.toUpperCase() });
    expect(asked.body).toEqual({ ok: true });
    expect(received.length).toBe(before + 1);
    const mail = received.at(-1)!;
    expect(mail.to).toEqual([owner.email]);
    const token = tokenFrom(mail);
    const stored = (await systemPool.query<{ hours: number; created_by: string | null }>(
      `SELECT extract(epoch FROM expires_at - created_at) / 3600 AS hours, created_by FROM auth_tokens WHERE purpose = 'password_reset' AND user_id = (SELECT id FROM users WHERE lower(email) = $1)`,
      [owner.email],
    )).rows;
    expect(stored).toHaveLength(1);
    expect(Number(stored[0]!.hours)).toBeCloseTo(1, 1);
    expect(stored[0]!.created_by).toBeNull();
    // Only a hash of the token is stored.
    expect(JSON.stringify((await systemPool.query(`SELECT * FROM auth_tokens WHERE purpose = 'password_reset'`)).rows)).not.toContain(token);

    expect((await request(app).post('/api/v1/auth/reset-password').set(CSRF).send({ token, new_password: 'short' })).status).toBe(400);
    const reset = await request(app).post('/api/v1/auth/reset-password').set(CSRF).send({ token, new_password: 'a brand new passphrase' });
    expect(reset.status).toBe(200);

    expect((await owner.agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await other.get('/api/v1/auth/me')).status).toBe(401);
    expect((await login(request.agent(app), owner.email)).status).toBe(401);
    expect((await login(request.agent(app), owner.email, 'a brand new passphrase')).status).toBe(200);
    const lock = (await systemPool.query<{ n: number; until: Date | null }>(`SELECT mfa_failed_attempts AS n, mfa_locked_until AS until FROM users WHERE lower(email) = $1`, [owner.email])).rows[0]!;
    expect(lock).toEqual({ n: 0, until: null });

    const reuse = await request(app).post('/api/v1/auth/reset-password').set(CSRF).send({ token, new_password: 'yet another passphrase' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('invalid_reset_token');
    expect(await auditRows(owner.organizationId, 'auth.password_reset')).toHaveLength(1);
  });

  it('self-service: an expired link is refused, and without account mail no link is created', async () => {
    const owner = await mailOrg('reset-expired');
    const before = received.length;
    await request(app).post('/api/v1/auth/forgot-password').set(CSRF).send({ email: owner.email });
    const token = tokenFrom(received.at(-1)!);
    expect(received.length).toBe(before + 1);
    await systemPool.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE purpose = 'password_reset' AND user_id = (SELECT id FROM users WHERE lower(email) = $1)`, [owner.email]);
    expect((await request(app).post('/api/v1/auth/reset-password').set(CSRF).send({ token, new_password: 'a brand new passphrase' })).status).toBe(400);

    const noMail = await newAccount('reset-nomail');
    expect((await request(app).post('/api/v1/auth/forgot-password').set(CSRF).send({ email: noMail.email })).body).toEqual({ ok: true });
    const tokens = await systemPool.query(`SELECT 1 FROM auth_tokens WHERE purpose = 'password_reset' AND user_id = (SELECT id FROM users WHERE lower(email) = $1)`, [noMail.email]);
    expect(tokens.rowCount).toBe(0);
    // CSRF header is required.
    expect((await request(app).post('/api/v1/auth/forgot-password').send({ email: noMail.email })).status).toBe(403);
  });

  it('admin-issued: returns and mails a link, respects roles and owners, and the member sets a new password with it', async () => {
    const owner = await mailOrg('reset-admin');
    const admin = await addMember(owner, 'admin');
    const tech = await addMember(owner, 'technician');
    const viewer = await addMember(owner, 'viewer');
    const ownerId = await userId(owner.email);

    expect((await tech.agent.post(`/api/v1/team/members/${viewer.id}/reset-password`).set(CSRF)).status).toBe(403);
    expect((await viewer.agent.post(`/api/v1/team/members/${tech.id}/reset-password`).set(CSRF)).status).toBe(403);
    expect((await admin.agent.post(`/api/v1/team/members/${ownerId}/reset-password`).set(CSRF)).status).toBe(403);
    const otherOrg = await newAccount('reset-admin-other');
    expect((await otherOrg.agent.post(`/api/v1/team/members/${tech.id}/reset-password`).set(CSRF)).status).toBe(404);

    const before = received.length;
    const issued = await admin.agent.post(`/api/v1/team/members/${tech.id}/reset-password`).set(CSRF);
    expect(issued.status).toBe(200);
    expect(issued.body.mail_outcome).toBe('sent');
    expect(issued.body.reset_url).toContain(`/reset-password?token=${encodeURIComponent(issued.body.token)}`);
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)!.to).toEqual([tech.email]);
    expect(tokenFrom(received.at(-1)!)).toBe(issued.body.token);
    const createdBy = (await systemPool.query<{ created_by: string }>(`SELECT created_by FROM auth_tokens WHERE purpose = 'password_reset' AND user_id = $1`, [tech.id])).rows[0]!.created_by;
    expect(createdBy).toBe(admin.id);

    expect((await request(app).post('/api/v1/auth/reset-password').set(CSRF).send({ token: issued.body.token, new_password: 'technician new phrase' })).status).toBe(200);
    expect((await tech.agent.get('/api/v1/auth/me')).status).toBe(401);
    expect((await login(request.agent(app), tech.email, 'technician new phrase')).status).toBe(200);

    const issuedAudit = await auditRows(owner.organizationId, 'member.password_reset_issued');
    expect(issuedAudit).toHaveLength(1);
    expect(issuedAudit[0]).toMatchObject({ user_id: admin.id, target_id: tech.id, metadata: { email: tech.email, mail_outcome: 'sent' } });
    expect(JSON.stringify(issuedAudit)).not.toContain(issued.body.token);
    expect(await auditRows(owner.organizationId, 'auth.password_reset')).toHaveLength(1);

    // Without account mail the link is still returned, for the administrator to hand over.
    const plain = await newAccount('reset-admin-nomail');
    const m = await addMember(plain, 'viewer');
    const handover = await plain.agent.post(`/api/v1/team/members/${m.id}/reset-password`).set(CSRF);
    expect(handover.status).toBe(200);
    expect(handover.body.mail_outcome).toBe('not_configured');
    expect(handover.body.token).toBeTruthy();
  });

  it('admin-issued: never for another administrator, nor for a person who also belongs to another organization (SEC-03)', async () => {
    const owner = await newAccount('reset-sec03');
    const admin = await addMember(owner, 'admin');
    const admin2 = await addMember(owner, 'admin');
    const tokensFor = async (id: string) => (await systemPool.query(`SELECT 1 FROM auth_tokens WHERE purpose = 'password_reset' AND user_id = $1`, [id])).rowCount;

    // An administrator cannot take over a second administrator (the two-person approval).
    const refused = await admin.agent.post(`/api/v1/team/members/${admin2.id}/reset-password`).set(CSRF);
    expect(refused.status).toBe(403);
    expect(await tokensFor(admin2.id)).toBe(0);
    // The owner still can.
    expect((await owner.agent.post(`/api/v1/team/members/${admin2.id}/reset-password`).set(CSRF)).status).toBe(200);

    // The victim owns another organization and is only a technician here: issuing a link here
    // would have reset the password of the other organization's owner.
    const victim = await newAccount('reset-sec03-victim');
    const inv = await owner.agent.post('/api/v1/team/invitations').set(CSRF).send({ email: victim.email, role: 'technician' });
    expect(inv.status).toBe(201);
    const acc = await request.agent(app).post(`/api/v1/auth/invitations/${inv.body.token}/accept`).set(CSRF).send({ password: PASSWORD });
    expect(acc.status).toBe(200);
    const victimId = await userId(victim.email);
    for (const issuer of [admin, owner]) {
      const r = await issuer.agent.post(`/api/v1/team/members/${victimId}/reset-password`).set(CSRF);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('member_in_other_organizations');
      expect(r.body.token).toBeUndefined();
    }
    expect(await tokensFor(victimId)).toBe(0);
    expect((await login(request.agent(app), victim.email)).status).toBe(200);
  });
});

describe('Only an owner adds, promotes, demotes or removes an administrator (SEC-04)', () => {
  it('admin: 403 + audited refusal on every admin path; still manages technicians and viewers; owner can', async () => {
    const owner = await newAccount('sec04');
    const admin = await addMember(owner, 'admin');
    const admin2 = await addMember(owner, 'admin');
    const tech = await addMember(owner, 'technician');
    const viewer = await addMember(owner, 'viewer');
    const roleOf = async (id: string) =>
      (await systemPool.query<{ role: string; status: string }>(`SELECT role, status FROM memberships WHERE organization_id = $1 AND user_id = $2`, [owner.organizationId, id])).rows[0];
    const expectRefused = (r: { status: number; body: { error?: { code?: string } } }) => {
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toBe('owner_required');
    };

    // Invite a second admin account of one's own: refused, nothing stored.
    const accomplice = `accomplice-${Math.random().toString(36).slice(2, 8)}@example.test`;
    expectRefused(await admin.agent.post('/api/v1/team/invitations').set(CSRF).send({ email: accomplice, role: 'admin' }));
    expect((await systemPool.query(`SELECT 1 FROM invitations WHERE lower(email) = $1`, [accomplice])).rowCount).toBe(0);
    // Promote a colluding technician: refused, role unchanged.
    expectRefused(await admin.agent.patch(`/api/v1/team/members/${tech.id}`).set(CSRF).send({ role: 'admin' }));
    expect(await roleOf(tech.id)).toEqual({ role: 'technician', status: 'active' });
    // Demote, deactivate or remove another admin: refused.
    expectRefused(await admin.agent.patch(`/api/v1/team/members/${admin2.id}`).set(CSRF).send({ role: 'viewer' }));
    expectRefused(await admin.agent.patch(`/api/v1/team/members/${admin2.id}`).set(CSRF).send({ status: 'deactivated' }));
    expectRefused(await admin.agent.delete(`/api/v1/team/members/${admin2.id}`).set(CSRF));
    expect(await roleOf(admin2.id)).toEqual({ role: 'admin', status: 'active' });
    // Owner management stays owner-only, as before.
    expect((await admin.agent.patch(`/api/v1/team/members/${tech.id}`).set(CSRF).send({ role: 'owner' })).status).toBe(403);

    const refused = await auditRows(owner.organizationId, 'team.admin_change_refused');
    expect(refused.map((r) => r.metadata?.what)).toEqual(['invite', 'role_change', 'role_change', 'status_change', 'remove']);
    expect(refused.every((r) => r.user_id === admin.id && r.metadata?.actor_role === 'admin')).toBe(true);
    expect(refused[0]!.metadata).toMatchObject({ email: accomplice, role: 'admin' });
    expect(refused[1]).toMatchObject({ target_id: tech.id, metadata: { requested_role: 'admin' } });

    // Technicians and viewers are still the admin's to manage.
    expect((await admin.agent.post('/api/v1/team/invitations').set(CSRF).send({ email: `t-${Math.random().toString(36).slice(2, 8)}@example.test`, role: 'technician' })).status).toBe(201);
    expect((await admin.agent.patch(`/api/v1/team/members/${viewer.id}`).set(CSRF).send({ role: 'technician' })).status).toBe(200);
    expect((await admin.agent.patch(`/api/v1/team/members/${viewer.id}`).set(CSRF).send({ role: 'viewer' })).status).toBe(200);

    // The owner can do all of it.
    expect((await owner.agent.post('/api/v1/team/invitations').set(CSRF).send({ email: accomplice, role: 'admin' })).status).toBe(201);
    expect((await owner.agent.patch(`/api/v1/team/members/${tech.id}`).set(CSRF).send({ role: 'admin' })).status).toBe(200);
    expect((await owner.agent.patch(`/api/v1/team/members/${tech.id}`).set(CSRF).send({ role: 'technician' })).status).toBe(200);
    expect((await owner.agent.delete(`/api/v1/team/members/${admin2.id}`).set(CSRF)).status).toBe(204);
    expect(await auditRows(owner.organizationId, 'team.admin_change_refused')).toHaveLength(5);
  });

  it('an admin invitation sent by a non-owner (before this rule) cannot be accepted', async () => {
    const owner = await newAccount('sec04-legacy');
    const admin = await addMember(owner, 'admin');
    const email = `legacy-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const token = `legacy-${Math.random().toString(36).slice(2)}`;
    await systemPool.query(
      `INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, invited_by_name, expires_at)
       VALUES ($1,$2,'admin',$3,$4,'admin',now() + interval '1 day')`,
      [owner.organizationId, email, sha256(token), admin.id],
    );
    const acc = await request.agent(app).post(`/api/v1/auth/invitations/${token}/accept`).set(CSRF).send({ password: PASSWORD });
    expect(acc.status).toBe(403);
    expect(acc.body.error.code).toBe('invitation_needs_owner');
    expect((await systemPool.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])).rowCount).toBe(0);
  });
});
