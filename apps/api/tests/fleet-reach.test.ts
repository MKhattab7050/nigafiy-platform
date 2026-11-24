import { createPublicKey, verify } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { MAX_PIN_FAILURES, buildTrailer, issueLink, proofFor, quickSupportKey, runQuickSupportSweep, verifyLink } from '../src/modules/endpoints/fleet-reach/quick-support.ts';
import { runRestartTimeouts } from '../src/modules/endpoints/fleet-reach/restarts.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Fleet Pro: reaching computers (migration 037): Nigafiy ID, address book, connect by name/ID/code,
// unattended access end to end, Request help, restart and reconnect (normal and safe mode, with
// fakes: nothing here restarts anything), Windows user sessions, Quick Support rendezvous.

type Cmd = { id: string; kind: string; payload: Record<string, unknown> };

const pollFor = async (cred: string): Promise<Cmd[]> => (await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({})).body.commands;

async function answer(cred: string, id: string, ok: boolean, data?: Record<string, unknown>, error?: string) {
  const r = await request(app)
    .post('/api/v1/agent/command-result')
    .set('Authorization', `Bearer ${cred}`)
    .send({ command_results: [{ id, ok, output: '', ...(data ? { data } : {}), ...(error ? { error } : {}) }] });
  expect(r.status).toBe(200);
}

const heartbeat = (cred: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/v1/agent/heartbeat')
    .set('Authorization', `Bearer ${cred}`)
    .send({ agent_version: '0.3.0', hostname: 'PC', os: 'windows', arch: 'amd64', uptime_seconds: 3600, cpu_pct: 5, ram_used_mb: 1000, ram_pct: 20, ...extra });

const audits = async (orgId: string, action: string) =>
  (await systemPool.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at, id`, [orgId, action])).rows;

async function addMember(owner: TestAccount, role: 'admin' | 'technician' | 'viewer'): Promise<TestAccount> {
  const other = await newAccount(`member-${role}`);
  const user = await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [other.email]);
  await systemPool.query(`INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3)`, [user.rows[0]!.id, owner.organizationId, role]);
  expect((await other.agent.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: owner.organizationId })).status).toBe(200);
  return { ...other, organizationId: owner.organizationId, siteId: owner.siteId };
}

const start = (a: TestAccount, epId: string, body: Record<string, unknown> = {}) =>
  a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Ticket 12: VPN', ...body });

/** Opens a session and has the fake agent accept it (banner shown). */
async function liveSession(a: TestAccount, epId: string, cred: string, body: Record<string, unknown> = {}) {
  const s = await start(a, epId, body);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  const open = (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!;
  await answer(cred, open.id, true, { consent: open.payload.consent_required ? 'accepted' : 'not_required', banner: 'shown', stream: 'starting' });
  return { session: s.body.session, open };
}

describe('fleet: reaching computers', () => {
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
  });
  afterAll(async () => {
    await endpointsModule.lifecycle.stop();
  });

  it('gives every computer a unique 9-digit Nigafiy ID and finds it by name, ID and in the Hub search', async () => {
    const a = await newAccount('reach-id');
    const one = await onlineEndpoint(a, 'ACC-PC-01');
    await onlineEndpoint(a, 'ACC-PC-02');
    const list = (await a.agent.get('/api/v1/endpoints')).body.items as Array<{ id: string; nigafiy_id: string; tags: string[] }>;
    expect(list).toHaveLength(2);
    for (const e of list) expect(e.nigafiy_id).toMatch(/^[1-9][0-9]{8}$/);
    expect(new Set(list.map((e) => e.nigafiy_id)).size).toBe(2);
    const id = list.find((e) => e.id === one.epId)!.nigafiy_id;

    const spaced = `${id.slice(0, 3)} ${id.slice(3, 6)} ${id.slice(6)}`;
    const byId = await a.agent.get(`/api/v1/fleet/connect/resolve?q=${encodeURIComponent(spaced)}`);
    expect(byId.body.targets).toEqual([{ kind: 'endpoint', endpoint: expect.objectContaining({ id: one.epId, nigafiy_id: id }) }]);
    const byName = await a.agent.get('/api/v1/fleet/connect/resolve?q=acc-pc-01');
    expect(byName.body.targets.map((t: { endpoint: { id: string } }) => t.endpoint.id)).toEqual([one.epId]);
    expect((await a.agent.get('/api/v1/fleet/connect/resolve?q=ACC-PC')).body.targets).toHaveLength(2);
    expect((await a.agent.get('/api/v1/fleet/connect/resolve?q=999999999')).body.targets).toEqual([]);

    const search = await a.agent.get(`/api/v1/search?q=${id}`);
    const hit = search.body.items.find((h: { kind: string; id: string }) => h.kind === 'endpoint' && h.id === one.epId);
    expect(hit.href).toBe(`/fleet/endpoints/${one.epId}?connect=1`);
    expect(hit.subtitle).toContain(`ID ${id}`);

    // Another organization never sees it.
    const b = await newAccount('reach-other');
    expect((await b.agent.get(`/api/v1/fleet/connect/resolve?q=${id}`)).body.targets).toEqual([]);
    // The agent receives its ID with every heartbeat (shown in its tray).
    expect((await heartbeat(one.cred)).body.nigafiy_id).toBe(id);
  });

  it('address book: tags (admin), favourites per operator, filters, bulk actions with per-computer results', async () => {
    const a = await newAccount('reach-book');
    const tech = await addMember(a, 'technician');
    const viewer = await addMember(a, 'viewer');
    const p1 = await onlineEndpoint(a, 'BOOK-01');
    const p2 = await onlineEndpoint(a, 'BOOK-02');
    await heartbeat(p2.cred, { logged_in_users: ['CORP\\layla'] });

    expect((await tech.agent.post('/api/v1/fleet/address-book/tags').set(CSRF).send({ endpoint_ids: [p1.epId], add: ['finance'] })).status).toBe(403);
    const tagged = await a.agent.post('/api/v1/fleet/address-book/tags').set(CSRF).send({ endpoint_ids: [p1.epId, p2.epId], add: ['Finance', 'floor 2'] });
    expect(tagged.body).toEqual({ updated: 2 });
    await a.agent.post('/api/v1/fleet/address-book/tags').set(CSRF).send({ endpoint_ids: [p2.epId], remove: ['floor 2'] });
    expect((await a.agent.post('/api/v1/fleet/address-book/tags').set(CSRF).send({ endpoint_ids: [p1.epId], add: ['<script>'] })).status).toBe(400);
    expect((await a.agent.get('/api/v1/endpoints?tag=floor%202')).body.items.map((e: { id: string }) => e.id)).toEqual([p1.epId]);
    expect((await a.agent.get('/api/v1/endpoints?tag=finance')).body.items).toHaveLength(2);

    expect((await tech.agent.put(`/api/v1/fleet/favourites/${p2.epId}`).set(CSRF)).status).toBe(200);
    expect((await viewer.agent.put(`/api/v1/fleet/favourites/${p2.epId}`).set(CSRF)).status).toBe(403);
    expect((await tech.agent.get('/api/v1/endpoints?favourites=1')).body.items.map((e: { id: string; favourite: boolean }) => [e.id, e.favourite])).toEqual([[p2.epId, true]]);
    // Favourites are per operator.
    expect((await a.agent.get('/api/v1/endpoints?favourites=1')).body.items).toEqual([]);

    expect((await a.agent.get('/api/v1/endpoints?user=layla')).body.items.map((e: { id: string }) => e.id)).toEqual([p2.epId]);
    expect((await a.agent.get('/api/v1/endpoints?q=BOOK-0')).body.items).toHaveLength(2);
    expect((await a.agent.get('/api/v1/endpoints?q=100%25')).body.items).toHaveLength(0);

    // Bulk: notify works for a technician; power restart keeps its admin rule per computer.
    const notify = await tech.agent.post('/api/v1/fleet/bulk').set(CSRF).send({ action: 'notify', endpoint_ids: [p1.epId, p2.epId], title: 'Maintenance', message: 'Tonight 22:00' });
    expect(notify.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect((await pollFor(p1.cred)).some((c) => c.kind === 'notify_user')).toBe(true);
    const power = await tech.agent.post('/api/v1/fleet/bulk').set(CSRF).send({ action: 'power', power: 'restart', endpoint_ids: [p1.epId], reason: 'Patch night' });
    expect(power.body.results).toEqual([{ endpoint_id: p1.epId, ok: false, code: 'forbidden', message: expect.any(String) }]);
    // Wake needs a computer that is offline and seen by a Sensor: an honest refusal per computer.
    const wake = await a.agent.post('/api/v1/fleet/bulk').set(CSRF).send({ action: 'wake', endpoint_ids: [p1.epId], reason: 'Patch night' });
    expect(wake.body.results[0]).toMatchObject({ ok: false, code: 'endpoint_online' });
    expect((await viewer.agent.post('/api/v1/fleet/bulk').set(CSRF).send({ action: 'refresh_inventory', endpoint_ids: [p1.epId] })).status).toBe(403);
    expect((await audits(a.organizationId, 'fleet.bulk_action')).length).toBe(3);
    expect((await audits(a.organizationId, 'fleet.tags_changed')).length).toBe(2);
  });

  it('unattended access through the 035 policy: no dialog, a notice first, then live; attended waits for Accept', async () => {
    const a = await newAccount('reach-unattended');
    const { epId, cred } = await onlineEndpoint(a, 'SRV-01');
    const g = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'Servers', access_mode: 'unattended' });
    await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: g.body.group.id });
    const s = await start(a, epId);
    expect(s.body.session).toMatchObject({ state: 'active', consent_mode: 'unattended' });
    const cmds = await pollFor(cred);
    expect(cmds.map((c) => c.kind).slice(0, 2)).toEqual(['notify_user', 'rd_session_open']);
    expect(cmds.find((c) => c.kind === 'rd_session_open')!.payload).toMatchObject({ consent_required: false, refuse_window_s: 0 });
    const st = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/session`);
    expect(st.body.fleet_session).toMatchObject({ state: 'active', consent_result: 'not_required', group_name: 'Servers' });

    await a.agent.patch(`/api/v1/fleet/groups/${g.body.group.id}`).set(CSRF).send({ access_mode: 'attended' });
    const att = await start(a, epId);
    expect(att.body.session).toMatchObject({ state: 'waiting_consent', consent_mode: 'prompt' });
  });

  it('Request help: tray note → Fleet list + Watch event → attended session from it → closed; all audited', async () => {
    const a = await newAccount('reach-help');
    const tech = await addMember(a, 'technician');
    const viewer = await addMember(a, 'viewer');
    const { epId, cred } = await onlineEndpoint(a, 'HELP-01');
    const r = await request(app).post('/api/v1/agent/help-request').set('Authorization', `Bearer ${cred}`).send({ note: 'Outlook will not open', user: 'CORP\\sami' });
    expect(r.status).toBe(201);
    expect((await request(app).post('/api/v1/agent/help-request').send({ note: 'x' })).status).toBe(401);

    const list = await tech.agent.get('/api/v1/fleet/help-requests');
    expect(list.body.requests).toEqual([expect.objectContaining({ id: r.body.id, endpoint_id: epId, note: 'Outlook will not open', requested_by: 'CORP\\sami', state: 'open', nigafiy_id: expect.stringMatching(/^\d{9}$/) })]);
    expect((await viewer.agent.get('/api/v1/fleet/help-requests')).status).toBe(403);
    expect((await a.agent.get('/api/v1/endpoints')).body.items[0].open_help_requests).toBe(1);
    const ev = await systemPool.query(`SELECT severity FROM network_events WHERE organization_id = $1 AND details->>'help_request_id' = $2`, [a.organizationId, r.body.id]);
    expect(ev.rows).toEqual([{ severity: 'warning' }]);

    // The organization default here is unattended; a session from a help request is attended.
    const s = await tech.agent.post(`/api/v1/fleet/help-requests/${r.body.id}/connect`).set(CSRF).send({ reason: 'Help request: Outlook' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.session).toMatchObject({ state: 'waiting_consent', consent_mode: 'prompt' });
    expect((await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!.payload).toMatchObject({ consent_required: true });
    const after = (await tech.agent.get('/api/v1/fleet/help-requests?state=all')).body.requests[0];
    expect(after).toMatchObject({ state: 'in_session', handled_by_email: tech.email, fleet_session_id: s.body.session.fleet_session_id });
    const row = (await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0];
    expect(row.help_request_id).toBe(r.body.id);

    expect((await tech.agent.post(`/api/v1/fleet/help-requests/${r.body.id}/close`).set(CSRF).send({ note: 'Fixed the profile' })).status).toBe(200);
    expect((await tech.agent.post(`/api/v1/fleet/help-requests/${r.body.id}/close`).set(CSRF).send({})).status).toBe(404);
    expect((await tech.agent.post(`/api/v1/fleet/help-requests/${r.body.id}/connect`).set(CSRF).send({ reason: 'again please' })).body.error.code).toBe('help_request_closed');
    for (const action of ['fleet.help_requested', 'fleet.help_session_started', 'fleet.help_closed']) expect((await audits(a.organizationId, action)).length).toBe(1);
    // The note is the person's request, but its text does not go into the audit row.
    expect(JSON.stringify(await audits(a.organizationId, 'fleet.help_requested'))).not.toContain('Outlook');
  });

  it('Windows user sessions: listed by the agent; another session or the sign-in screen needs the service', async () => {
    const a = await newAccount('reach-sessions');
    const { epId, cred } = await onlineEndpoint(a, 'TS-01');
    const sessions = [
      { id: 1, user: 'amal', domain: 'CORP', state: 'active', station: 'Console', console: true },
      { id: 3, user: 'omar', domain: 'CORP', state: 'disconnected', station: null, console: false },
    ];
    await heartbeat(cred, { user_sessions: sessions, boot_state: { service: false, safe_mode: false, safe_boot_flag: false } });
    const ep = (await a.agent.get(`/api/v1/endpoints/${epId}`)).body;
    expect(ep.user_sessions).toEqual(sessions);
    expect((await start(a, epId, { user_session: '3' })).body.error.code).toBe('user_session_needs_service');
    await heartbeat(cred, { user_sessions: sessions, boot_state: { service: true } });
    expect((await start(a, epId, { user_session: '7' })).body.error.code).toBe('user_session_unknown');
    expect((await start(a, epId, { user_session: 'admin' })).status).toBe(400);
    const s = await start(a, epId, { user_session: '3' });
    expect(s.body.session.user_session).toBe('3');
    expect((await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!.payload).toMatchObject({ user_session: '3' });
    const w = await start(a, epId, { user_session: 'winlogon' });
    expect(w.status).toBe(200);
    expect((await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0].user_session).toBe('winlogon');
  });

  it('restart and reconnect: safe mode needs the service, the session ends and resumes, safe boot is always cleared', async () => {
    const a = await newAccount('reach-restart');
    const tech = await addMember(a, 'technician');
    const { epId, cred } = await onlineEndpoint(a, 'RST-01');
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/restart`).set(CSRF).send({ mode: 'normal', reason: 'Apply update' })).body.error.code).toBe('no_remote_session');
    const { session } = await liveSession(a, epId, cred);
    expect((await tech.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/restart`).set(CSRF).send({ mode: 'normal', reason: 'Apply update' })).body.error.code).toBe('not_session_holder');
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/restart`).set(CSRF).send({ mode: 'safe_mode', reason: 'Remove driver' })).body.error.code).toBe('safe_mode_needs_service');
    await heartbeat(cred, { boot_state: { service: true, safe_mode: false, safe_boot_flag: false } });

    const req = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/restart`).set(CSRF).send({ mode: 'safe_mode', reason: 'Remove driver' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    expect(req.body.restart).toMatchObject({ state: 'queued', mode: 'safe_mode' });
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/restart`).set(CSRF).send({ mode: 'normal', reason: 'again' })).body.error.code).toBe('restart_in_progress');
    const cmd = (await pollFor(cred)).find((c) => c.kind === 'fleet_restart')!;
    expect(cmd.payload).toMatchObject({ mode: 'safe_mode', restart_id: req.body.restart.id, session_id: session.id });
    await answer(cred, cmd.id, true, { safe_boot_set: true });
    let st = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/restart`);
    expect(st.body.restart).toMatchObject({ state: 'restarting', safe_boot_set: true, agent_back_at: null });
    const ended = (await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0];
    expect(ended).toMatchObject({ public_id: session.id, state: 'ended', end_reason: 'restart' });

    // Back in safe mode, but the flag is still set (the agent could not clear it yet): the API asks again.
    await systemPool.query(`UPDATE fleet_restarts SET decided_at = now() - interval '90 seconds' WHERE id = $1`, [req.body.restart.id]);
    const back = await heartbeat(cred, { uptime_seconds: 30, boot_state: { service: true, safe_mode: true, safe_boot_flag: true } });
    const clear = (back.body.commands as Cmd[]).find((c) => c.kind === 'fleet_safe_boot_clear')!;
    expect(clear.payload).toEqual({ restart_id: req.body.restart.id });
    // Only the operator who asked resumes it.
    expect((await tech.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/restart`)).body.session).toBeNull();
    st = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/restart`);
    expect(st.body.restart).toMatchObject({ state: 'resumed' });
    expect(st.body.session).toMatchObject({ state: 'active', reason: 'Ticket 12: VPN', profile_name: 'Support' });
    const resumed = (await a.agent.get(`/api/v1/fleet/sessions?endpoint_id=${epId}&limit=1`)).body.sessions[0];
    expect(resumed).toMatchObject({ resumed_from_id: ended.id, restart_id: req.body.restart.id, state: 'active' });
    await answer(cred, clear.id, true, { safe_boot_flag: false });
    st = await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/restart`);
    expect(st.body.restart.safe_boot_cleared_at).not.toBeNull();

    // A safe-mode restart that never comes back: timeout, and the flag gets cleared when it returns.
    await answer(cred, (await pollFor(cred)).find((c) => c.kind === 'rd_session_open')!.id, true, { consent: 'not_required', banner: 'shown', stream: 'starting' });
    const r2 = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/restart`).set(CSRF).send({ mode: 'safe_mode', reason: 'Second try' });
    const c2 = (await pollFor(cred)).find((c) => c.kind === 'fleet_restart')!;
    await answer(cred, c2.id, true, { safe_boot_set: true });
    await systemPool.query(`UPDATE fleet_restarts SET timeout_at = now() - interval '1 second' WHERE id = $1`, [r2.body.restart.id]);
    expect(await runRestartTimeouts()).toBe(1);
    const tRow = (await systemPool.query(`SELECT state, clear_command_id FROM fleet_restarts WHERE id = $1`, [r2.body.restart.id])).rows[0];
    expect(tRow.state).toBe('timeout');
    expect(tRow.clear_command_id).not.toBeNull();

    // The agent refusing (e.g. bcdedit failed) fails the restart and clears the flag too.
    const s3 = await liveSession(a, epId, cred);
    expect(s3.session.state).toBe('active');
    const r3 = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/restart`).set(CSRF).send({ mode: 'normal', reason: 'Third' });
    const c3 = (await pollFor(cred)).find((c) => c.kind === 'fleet_restart')!;
    await answer(cred, c3.id, false, undefined, 'shutdown refused');
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/restart`)).body.restart).toMatchObject({ id: r3.body.restart.id, state: 'failed', error: 'shutdown refused' });
    for (const action of ['fleet.restart_requested', 'fleet.restarting', 'fleet.restart_agent_back', 'fleet.session_resumed', 'fleet.safe_boot_cleared', 'fleet.restart_timeout', 'fleet.restart_failed']) {
      expect((await audits(a.organizationId, action)).length, action).toBeGreaterThan(0);
    }
  });

  it('Quick Support: signed binding, code + one-time PIN, lockout, attended Support only, ends and revokes', async () => {
    const a = await newAccount('reach-qs');
    const tech = await addMember(a, 'technician');
    // The signed link: tampering or expiry is refused.
    const link = issueLink(a.organizationId, a.siteId);
    expect(verifyLink(link)).toEqual({ orgId: a.organizationId, siteId: a.siteId });
    expect(verifyLink(link.replace(a.siteId, a.organizationId))).toBeNull();
    expect(verifyLink(link, Date.now() + 8 * 24 * 3600_000)).toBeNull();
    // The trailer verifies with the key in it, and changing the server breaks the signature.
    const trailer = buildTrailer({ server: 'https://it.example', tlsPin: null, link, issuedBy: a.email });
    const json = JSON.parse(trailer.subarray(1, trailer.length - 14).toString());
    const payload = Buffer.from(json.payload, 'base64');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(JSON.parse(payload.toString()).key, 'base64')]), format: 'der', type: 'spki' });
    const signed = (p: Buffer) => verify(null, Buffer.concat([Buffer.from('nigafiy-qs1\n'), p]), key, Buffer.from(json.sig, 'base64'));
    expect(signed(payload)).toBe(true);
    expect(signed(Buffer.from(payload.toString().replace('it.example', 'evil.example')))).toBe(false);
    expect(trailer.subarray(-10).toString()).toBe('NIGAFIYQS1');
    expect(quickSupportKey().fingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);

    const register = () => request(app).post('/api/v1/agent/quick-support/register').send({ link, nonce: 'n0nce-0123456789abcdef', hostname: 'GUEST-LAPTOP', os: 'windows', arch: 'amd64' });
    expect((await request(app).post('/api/v1/agent/quick-support/register').send({ link: `${link.slice(0, -1)}${link.endsWith('0') ? '1' : '0'}`, nonce: 'n0nce-0123456789abcdef', hostname: 'X', os: 'windows' })).status).toBe(401);
    const reg = await register();
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    expect(reg.body.code).toMatch(/^[1-9][0-9]{8}$/);
    expect(reg.body.pin).toMatch(/^[0-9]{6}$/);
    expect(reg.body.proof).toBe(proofFor('n0nce-0123456789abcdef', reg.body.code));
    const cred = reg.body.credential as string;
    // Never in the address book, never reachable without the code.
    expect((await a.agent.get('/api/v1/endpoints')).body.items).toEqual([]);
    expect((await start(a, reg.body.endpoint_id)).body.error.code).toBe('quick_support_needs_code');
    const listed = (await tech.agent.get('/api/v1/fleet/quick-support')).body.sessions[0];
    expect(listed).toMatchObject({ state: 'waiting', code: `${reg.body.code.slice(0, 3)} *** ***` });
    expect(JSON.stringify(listed)).not.toContain(reg.body.pin);
    expect((await tech.agent.get(`/api/v1/fleet/connect/resolve?q=${reg.body.code}`)).body.targets).toEqual([{ kind: 'quick_support', code: reg.body.code, needs_pin: true }]);

    const connect = (pin: string, extra: Record<string, unknown> = {}) =>
      tech.agent.post('/api/v1/fleet/quick-support/connect').set(CSRF).send({ code: reg.body.code, pin, reason: 'Guest laptop printer', ...extra });
    const wrong = reg.body.pin === '000000' ? '111111' : '000000';
    for (let i = 1; i < MAX_PIN_FAILURES; i++) expect((await connect(wrong)).body.error.code).toBe('quick_support_wrong_pin');
    expect((await connect(wrong)).body.error.code).toBe('quick_support_locked');
    // Locked: even the right PIN does not open it, and the program's credential is revoked.
    expect((await connect(reg.body.pin)).status).toBe(423);
    expect((await request(app).get('/api/v1/agent/quick-support/status').set('Authorization', `Bearer ${cred}`)).status).toBe(401);
    expect((await audits(a.organizationId, 'fleet.quick_support_failed')).length).toBe(MAX_PIN_FAILURES);

    // A new run: the right PIN, a Full admin request is capped at Support and is attended.
    const reg2 = await register();
    const profiles = (await a.agent.get('/api/v1/fleet/profiles')).body.profiles as Array<{ id: string; builtin_key: string | null }>;
    const full = profiles.find((p) => p.builtin_key === 'full_admin')!;
    const ok = await tech.agent
      .post('/api/v1/fleet/quick-support/connect')
      .set(CSRF)
      .send({ code: `${reg2.body.code.slice(0, 3)}-${reg2.body.code.slice(3)}`, pin: reg2.body.pin, reason: 'Guest laptop printer', profile_id: full.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.session).toMatchObject({ state: 'waiting_consent', consent_mode: 'prompt', profile_name: 'Full admin', quick_support: true, permissions: { shell: false, privacy_screen: false, block_input: false } });
    const open = (await pollFor(reg2.body.credential)).find((c) => c.kind === 'rd_session_open')!;
    expect(open.payload).toMatchObject({ consent_required: true });
    const st = await request(app).get('/api/v1/agent/quick-support/status').set('Authorization', `Bearer ${reg2.body.credential}`);
    expect(st.body).toMatchObject({ state: 'connected', operator: tech.email });
    expect((await tech.agent.post(`/api/v1/endpoints/${reg2.body.endpoint_id}/commands`).set(CSRF).send({ kind: 'service_action', service: 'Spooler', action: 'restart' })).body.error.code).toBe(
      'quick_support_limited',
    );
    // The PIN was one-time: the same code and PIN do not connect a second operator.
    expect((await tech.agent.post('/api/v1/fleet/quick-support/connect').set(CSRF).send({ code: reg2.body.code, pin: reg2.body.pin, reason: 'Second try here' })).body.error.code).toBe(
      'quick_support_code_unknown',
    );

    // The operator ends the session: the code ends, the program's credential goes, it exits.
    expect((await tech.agent.post(`/api/v1/endpoints/${reg2.body.endpoint_id}/remote-desktop/stop`).set(CSRF)).status).toBe(200);
    expect(await runQuickSupportSweep()).toBeGreaterThanOrEqual(1);
    expect((await request(app).get('/api/v1/agent/quick-support/status').set('Authorization', `Bearer ${reg2.body.credential}`)).status).toBe(401);
    const done = (await tech.agent.get('/api/v1/fleet/quick-support')).body.sessions.find((q: { endpoint_id: string }) => q.endpoint_id === reg2.body.endpoint_id);
    expect(done).toMatchObject({ state: 'ended', end_reason: 'session_ended', code: reg2.body.code });

    // A code nobody uses expires; the person closing the program ends it at once.
    const reg3 = await register();
    await systemPool.query(`UPDATE fleet_quick_support SET expires_at = now() - interval '1 second' WHERE endpoint_id = $1`, [reg3.body.endpoint_id]);
    expect((await tech.agent.post('/api/v1/fleet/quick-support/connect').set(CSRF).send({ code: reg3.body.code, pin: reg3.body.pin, reason: 'Late arrival' })).status).toBe(404);
    const reg4 = await register();
    expect((await request(app).post('/api/v1/agent/quick-support/close').set('Authorization', `Bearer ${reg4.body.credential}`).send({})).status).toBe(200);
    expect((await systemPool.query(`SELECT state, end_reason FROM fleet_quick_support WHERE endpoint_id = $1`, [reg4.body.endpoint_id])).rows[0]).toEqual({ state: 'ended', end_reason: 'closed_by_user' });
    for (const action of ['fleet.quick_support_registered', 'fleet.quick_support_connected', 'fleet.quick_support_ended', 'fleet.quick_support_expired', 'fleet.quick_support_locked']) {
      expect((await audits(a.organizationId, action)).length, action).toBeGreaterThan(0);
    }
    // Download: the built program with the binding appended, or an honest 503 when it is not built.
    const dl = await tech.agent.get(`/api/v1/fleet/quick-support/download?site_id=${a.siteId}`).responseType('blob');
    expect([200, 503]).toContain(dl.status);
    const bytes = Buffer.from(dl.body as Buffer);
    if (dl.status === 503) expect(JSON.parse(bytes.toString()).error.code).toBe('quick_support_not_built');
    else {
      expect(bytes.subarray(0, 2).toString()).toBe('MZ');
      expect(bytes.subarray(-10).toString()).toBe('NIGAFIYQS1');
    }
    expect((await audits(a.organizationId, 'fleet.quick_support_downloaded')).length).toBe(dl.status === 200 ? 1 : 0);
  });
});
