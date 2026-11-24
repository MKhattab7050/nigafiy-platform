import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { waitingPollCount } from '../src/modules/endpoints/agent/wake.ts';
import { systemPool, withTenant } from '../src/infrastructure/db.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, setRole } from './helpers.ts';

describe('agent long poll (?wait_ms=, woken through pg_notify)', () => {
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
  });
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it('holds an empty poll and answers as soon as a command is queued', async () => {
    const a = await newAccount('longpoll');
    const { epId, cred } = await onlineEndpoint(a);

    // Nothing pending: without wait_ms the poll answers at once (older agents).
    const quick = await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({});
    expect(quick.body.commands).toEqual([]);

    const started = Date.now();
    const polling = request(app).post('/api/v1/agent/poll?wait_ms=15000').set('Authorization', `Bearer ${cred}`).send({});
    const queued = (async () => {
      await new Promise((r) => setTimeout(r, 400));
      return a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'refresh_inventory' });
    })();
    const [poll, cmd] = await Promise.all([polling, queued]);
    expect(cmd.status).toBe(202);
    expect(poll.status).toBe(200);
    expect(poll.body.commands.map((c: { id: string }) => c.id)).toEqual([cmd.body.id]);
    // Woken by the notification: far sooner than the 15 s wait and the 2 s re-check.
    expect(Date.now() - started).toBeLessThan(1_900);
  });

  it('is woken by a command inserted through another database connection (another API instance)', async () => {
    const a = await newAccount('longpoll2');
    const { epId, cred } = await onlineEndpoint(a);
    const started = Date.now();
    const polling = request(app).post('/api/v1/agent/poll?wait_ms=15000').set('Authorization', `Bearer ${cred}`).send({});
    await new Promise((r) => setTimeout(r, 300));
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    let id = '';
    try {
      const ins = await other.query<{ id: string }>(
        `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload) VALUES ($1,$2,'refresh_inventory','{}') RETURNING id`,
        [a.organizationId, epId],
      );
      id = ins.rows[0]!.id;
    } finally {
      await other.end();
    }
    const poll = await polling;
    expect(poll.body.commands.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(Date.now() - started).toBeLessThan(1_900);
  });

  it('returns an empty list when the wait ends, caps the wait and stops waiting when the agent disconnects', async () => {
    const a = await newAccount('longpoll3');
    const { cred } = await onlineEndpoint(a);
    const started = Date.now();
    const poll = await request(app).post('/api/v1/agent/poll?wait_ms=700').set('Authorization', `Bearer ${cred}`).send({});
    expect(poll.body.commands).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);

    // A disconnected agent's poll is not left waiting.
    const before = waitingPollCount();
    const req = request(app).post('/api/v1/agent/poll?wait_ms=20000').set('Authorization', `Bearer ${cred}`).timeout(300).send({});
    await req.then(
      () => undefined,
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(waitingPollCount()).toBe(before);

    // A bad credential is refused before any wait.
    const bad = await request(app).post('/api/v1/agent/poll?wait_ms=20000').set('Authorization', 'Bearer lda_00000000-0000-0000-0000-000000000000.xxxxxxxxxxxxxxxxxxxxxxxx').send({});
    expect(bad.status).toBe(401);
  });
});


// ── Fleet sessions: consent, banner, history (items 4, 5, 10) ──────────────────────────────────

async function pollFor(cred: string): Promise<Array<{ id: string; kind: string; payload: Record<string, unknown> }>> {
  const r = await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({});
  return r.body.commands;
}

async function answer(cred: string, id: string, ok: boolean, data?: Record<string, unknown>, error?: string) {
  const r = await request(app)
    .post('/api/v1/agent/command-result')
    .set('Authorization', `Bearer ${cred}`)
    .send({ command_results: [{ id, ok, output: '', ...(data ? { data } : {}), ...(error ? { error } : {}) }] });
  expect(r.status).toBe(200);
}

async function auditActions(orgId: string, epId: string): Promise<Array<{ action: string; metadata: Record<string, unknown>; actor: string; user_email: string | null }>> {
  const r = await systemPool.query(`SELECT action, metadata, actor, user_email FROM audit_logs WHERE organization_id = $1 AND target_id = $2 ORDER BY created_at, id`, [orgId, epId]);
  return r.rows;
}

describe('fleet sessions: consent, banner and history', () => {
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
  });
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it('asks the user under "prompt": nothing is captured until accepted, then the session is live', async () => {
    const a = await newAccount('consent');
    const { epId, cred } = await onlineEndpoint(a);
    await a.agent.patch(`/api/v1/endpoints/${epId}/policy`).set(CSRF).send({ remote_desktop_consent: 'prompt' });

    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Printer driver ticket #42' });
    expect(start.status).toBe(200);
    expect(start.body.session.state).toBe('waiting_consent');
    expect(start.body.session.reason).toBe('Printer driver ticket #42');

    const cmds = await pollFor(cred);
    expect(cmds.map((c) => c.kind)).toEqual(['rd_session_open']);
    const open = cmds[0]!;
    expect(open.payload).toMatchObject({
      session_id: start.body.session.id,
      operator: a.email,
      reason: 'Printer driver ticket #42',
      consent_required: true,
      consent_timeout_s: 60,
      stream: true,
    });

    const early = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_capture' });
    expect(early.body.error.code).toBe('consent_pending');
    const waiting = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`);
    expect(waiting.body.fleet_session).toMatchObject({ state: 'waiting_consent', consent_mode: 'prompt', consent_result: 'pending', operator_email: a.email });

    await answer(cred, open.id, true, { consent: 'accepted', banner: 'shown', stream: 'connecting', desktop: { mode: 'helper' } });
    const live = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`);
    expect(live.body.session.state).toBe('active');
    expect(live.body.fleet_session).toMatchObject({ state: 'active', consent_result: 'accepted', banner_state: 'shown', desktop_mode: 'helper' });
    expect(live.body.fleet_session.accepted_at).toBeTruthy();
    const capture = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_capture' });
    expect(capture.status).toBe(202);

    const actions = await auditActions(a.organizationId, epId);
    const consent = actions.find((x) => x.action === 'fleet.session_consent');
    expect(consent?.metadata).toMatchObject({ result: 'accepted', source: 'endpoint_agent' });
    expect(consent?.actor).toBe('system');
    expect(actions.some((x) => x.action === 'fleet.session_opened' && x.user_email === a.email)).toBe(true);

    // The operator ends it: history closed, banner removed on the agent.
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({})).status).toBe(200);
    const after = await pollFor(cred);
    expect(after.find((c) => c.kind === 'rd_session_close')?.payload).toMatchObject({ session_id: start.body.session.id, reason: 'operator' });
    const hist = await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}`);
    expect(hist.body.sessions[0]).toMatchObject({
      state: 'ended',
      end_reason: 'operator',
      ended_by_email: a.email,
      reason: 'Printer driver ticket #42',
      endpoint_name: 'FLEET-PC-01',
    });
  });

  it('ends the session when the user declines, does not answer, or the agent cannot ask', async () => {
    const a = await newAccount('consent-no');
    const { epId, cred } = await onlineEndpoint(a);
    await a.agent.patch(`/api/v1/endpoints/${epId}/policy`).set(CSRF).send({ remote_desktop_consent: 'prompt' });

    const cases: Array<[Record<string, unknown> | undefined, boolean, string]> = [
      [{ consent: 'denied', banner: 'pending' }, true, 'consent_denied'],
      [{ consent: 'timeout', banner: 'pending' }, true, 'consent_timeout'],
      [{ consent: 'unavailable', consent_error: 'no interactive desktop session' }, true, 'consent_unavailable'],
      [undefined, false, 'consent_unavailable'],
    ];
    for (const [data, ok, expected] of cases) {
      const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Fleet test session' });
      expect(start.status).toBe(200);
      const open = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
      await answer(cred, open.id, ok, data, ok ? undefined : 'unknown command kind "rd_session_open"');
      const st = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`);
      expect(st.body.session).toBeNull();
      const row = (await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0];
      expect(row).toMatchObject({ state: 'ended', end_reason: expected, public_id: start.body.session.id });
      const capture = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_capture' });
      expect(capture.body.error.code).toBe('no_remote_session');
    }
    const consents = (await auditActions(a.organizationId, epId)).filter((x) => x.action === 'fleet.session_consent').map((x) => x.metadata.result);
    expect(consents).toEqual(['denied', 'timeout', 'unavailable', 'unavailable']);
  });

  it('unattended: records the banner and lets the person at the computer end the session', async () => {
    const a = await newAccount('banner');
    const { epId, cred } = await onlineEndpoint(a);
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Fleet test session' });
    expect(start.body.session.state).toBe('active');
    const cmds = await pollFor(cred);
    // Told first (notice), then the banner/stream command, then the first HTTP frame.
    expect(cmds.map((c) => c.kind)).toEqual(['notify_user', 'rd_session_open', 'rd_capture']);
    expect(cmds[1]!.payload.consent_required).toBe(false);
    await answer(cred, cmds[1]!.id, true, { consent: 'not_required', banner: 'shown', stream: 'connecting' });
    const st = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`);
    expect(st.body.fleet_session).toMatchObject({ consent_result: 'not_required', banner_state: 'shown' });

    // Another endpoint's credential cannot end it; a stale session id is ignored.
    const other = await onlineEndpoint(a, 'FLEET-PC-02');
    const wrongAgent = await request(app).post('/api/v1/agent/rd-session/end').set('Authorization', `Bearer ${other.cred}`).send({ session_id: start.body.session.id });
    expect(wrongAgent.body.ended).toBe(false);
    const stale = await request(app).post('/api/v1/agent/rd-session/end').set('Authorization', `Bearer ${cred}`).send({ session_id: 'nope' });
    expect(stale.body.ended).toBe(false);

    const end = await request(app).post('/api/v1/agent/rd-session/end').set('Authorization', `Bearer ${cred}`).send({ session_id: start.body.session.id });
    expect(end.body).toEqual({ ok: true, ended: true });
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`)).body.session).toBeNull();
    const row = (await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}`)).body.sessions[0];
    expect(row).toMatchObject({ state: 'ended', end_reason: 'user', ended_by_email: null });
    const actions = await auditActions(a.organizationId, epId);
    expect(actions.find((x) => x.action === 'fleet.session_banner')?.metadata).toMatchObject({ banner: 'shown' });
    expect(actions.find((x) => x.action === 'fleet.session_ended')?.metadata).toMatchObject({ end_reason: 'user', ended_by: 'endpoint_user' });
    // The agent is told to remove the banner.
    expect((await pollFor(cred)).map((c) => c.kind)).toContain('rd_session_close');
  });

  it('macOS sessions take mouse and keyboard input (CoreGraphics on the agent), not view-only', async () => {
    const a = await newAccount('mac-input');
    const { epId, cred } = await onlineEndpoint(a, 'MAC-01', 'macos');
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Fleet test session' });
    expect(start.status).toBe(200);
    const open = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
    await answer(cred, open.id, true, { consent: 'not_required', banner: 'shown', stream: 'connecting' });
    const typed = await a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'rd_input', event_kind: 'key_press', key: 'c', ctrl: true });
    expect(typed.status).toBe(202);
    const caps = (await a.agent.get(`/api/v1/endpoints/${epId}`)).body.capabilities as Array<{ key: string; label_en: string; reason_en: string }> | undefined;
    const rd = caps?.find((c) => c.key === 'remote_desktop');
    // An agent reporting os 'darwin' is macOS ('darwin' contains 'win': it was taken for Windows).
    expect(rd?.reason_en).toContain('Accessibility');
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF).send({});
  });

  it('history is for technicians and above, and stays inside the organization', async () => {
    const a = await newAccount('hist');
    const b = await newAccount('hist-other');
    const { epId } = await onlineEndpoint(a);
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Fleet test session' });
    expect((await a.agent.get('/api/v1/fleet/sessions')).body.sessions).toHaveLength(1);
    expect((await b.agent.get('/api/v1/fleet/sessions')).body.sessions).toHaveLength(0);
    expect((await b.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`)).status).toBe(404);
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get('/api/v1/fleet/sessions')).status).toBe(403);
    // The table keeps history: the application role cannot delete it.
    await expect(withTenant(a.organizationId, (db) => db.query('DELETE FROM fleet_sessions'))).rejects.toThrow(/permission denied/);
  });
});
