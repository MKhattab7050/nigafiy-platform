import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { systemPool } from '../src/infrastructure/db.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { ShellHub } from '../src/modules/endpoints/fleet-shell/hub.ts';
import { runShellSweep } from '../src/modules/endpoints/fleet-shell/shells.ts';
import { StreamHub } from '../src/modules/endpoints/remote-desktop/stream-hub.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Fleet Pro: remote shell (migration 042): admins only, the group switch (off by default), the
// access policy (MFA), the profile's "shell" flag, the agent and operator sockets over real `ws`
// servers (two hubs stand for two API instances relaying through pg_notify), the encrypted
// transcript (never in the plain audit), ending from either side, idle and size limits, and the
// person's IT activity list.

const ORIGIN = 'http://localhost:3100';
type Cmd = { id: string; kind: string; payload: Record<string, unknown> };

interface Instance {
  server: http.Server;
  hub: ShellHub;
  base: string;
}

async function instance(): Promise<Instance> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const hub = new ShellHub();
  hub.start();
  new StreamHub({ peerUrl: base, shell: hub }).attach(server);
  return { server, hub, base };
}

class Peer {
  readonly bytes: Buffer[] = [];
  readonly texts: Array<Record<string, unknown>> = [];
  closed: number | null = null;
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (isBinary) this.bytes.push(buf);
      else this.texts.push(JSON.parse(buf.toString('utf8')));
    });
    ws.on('close', (code) => {
      this.closed = code;
    });
  }
  text(): string {
    return Buffer.concat(this.bytes).toString('utf8');
  }
  async until<T>(fn: () => T | undefined | null | false, what: string, ms = 5000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}

function open(url: string, headers: Record<string, string>): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const p = new Peer(ws);
    ws.once('open', () => resolve(p));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

const ws = (base: string, path: string) => base.replace(/^http/, 'ws') + path;
const agentSocket = (i: Instance, cred: string, shell: string) => open(ws(i.base, `/api/v1/agent/shell?shell=${shell}`), { Authorization: `Bearer ${cred}` });
const operatorSocket = (i: Instance, cookie: string, epId: string, shell: string, origin = ORIGIN) =>
  open(ws(i.base, `/api/v1/endpoints/${epId}/shell/stream?shell=${shell}`), { Cookie: cookie, Origin: origin });

async function refused(p: Promise<Peer>): Promise<string> {
  try {
    (await p).ws.close();
    return 'opened';
  } catch (err) {
    return (err as Error).message;
  }
}

async function loginCookie(a: TestAccount): Promise<string> {
  const r = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email: a.email, password: 'correct horse battery' });
  const c = ((r.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((s) => s.startsWith('ld_session='));
  if (!c) throw new Error(`login: ${r.status}`);
  return c.split(';')[0]!;
}

const pollFor = async (cred: string): Promise<Cmd[]> => (await request(app).post('/api/v1/agent/poll').set('Authorization', `Bearer ${cred}`).send({})).body.commands;

const audits = async (orgId: string, action: string) =>
  (await systemPool.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at, id`, [orgId, action])).rows;

async function addMember(owner: TestAccount, role: 'admin' | 'technician' | 'viewer'): Promise<TestAccount> {
  const other = await newAccount(`member-${role}`);
  const user = await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [other.email]);
  await systemPool.query(`INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3)`, [user.rows[0]!.id, owner.organizationId, role]);
  expect((await other.agent.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: owner.organizationId })).status).toBe(200);
  return { ...other, organizationId: owner.organizationId, siteId: owner.siteId };
}

async function profileId(a: TestAccount, key: string): Promise<string> {
  const r = await a.agent.get('/api/v1/fleet/profiles');
  return (r.body.profiles as Array<{ id: string; builtin_key: string }>).find((p) => p.builtin_key === key)!.id;
}

/** A computer in a group with the shell switched on (Full admin allowed). */
async function shellComputer(a: TestAccount, name: string, group: Record<string, unknown> = {}) {
  const ep = await onlineEndpoint(a, name);
  const g = (await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: `Shell ${name}`, shell_enabled: true, ...group })).body.group;
  await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [ep.epId], fleet_group_id: g.id });
  return { ...ep, groupId: g.id as string };
}

const openShell = async (a: TestAccount, epId: string, body: Record<string, unknown> = {}) => a.agent.post(`/api/v1/endpoints/${epId}/shell`).set(CSRF).send({ reason: 'Ticket 77: disk full', ...body });

describe('fleet: remote shell', () => {
  let A: Instance;
  let B: Instance;
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
    A = await instance();
    B = await instance();
  });
  afterAll(async () => {
    for (const i of [A, B]) {
      await i.hub.stop();
      await new Promise<void>((resolve) => i.server.close(() => resolve()));
    }
    await endpointsModule.lifecycle.stop();
  });

  it('is refused unless an admin asks, the group switched it on, the policy passes and the profile has "shell"', async () => {
    const a = await newAccount('shell-refuse');
    const tech = await addMember(a, 'technician');
    const viewer = await addMember(a, 'viewer');
    const plain = await onlineEndpoint(a, 'SH-NOGROUP');
    // No group: the organization default has no shell.
    expect((await openShell(a, plain.epId)).body.error.code).toBe('shell_disabled_by_policy');
    // A group with the switch off (the default).
    const g = (await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'Office' })).body.group;
    expect(g.shell_enabled).toBe(false);
    await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [plain.epId], fleet_group_id: g.id });
    expect((await openShell(a, plain.epId)).body.error.code).toBe('shell_disabled_by_policy');

    const ep = await shellComputer(a, 'SH-PC-01');
    // Technicians never; viewers are refused at the door.
    expect((await openShell(tech, ep.epId)).body.error.code).toBe('shell_admin_only');
    expect((await openShell(viewer, ep.epId)).status).toBe(403);
    // The Support profile has no shell flag.
    expect((await openShell(a, ep.epId, { profile_id: await profileId(a, 'support') })).body.error.code).toBe('profile_forbids_shell');
    // A maximum without the shell flag clamps Full admin down: refused.
    await a.agent.patch(`/api/v1/fleet/groups/${ep.groupId}`).set(CSRF).send({ max_profile_id: await profileId(a, 'support'), default_profile_id: await profileId(a, 'support') });
    expect((await openShell(a, ep.epId, { profile_id: await profileId(a, 'full_admin') })).body.error.code).toBe('profile_forbids_shell');
    await a.agent.patch(`/api/v1/fleet/groups/${ep.groupId}`).set(CSRF).send({ max_profile_id: await profileId(a, 'full_admin'), mfa_required: true });
    // MFA asked by the policy: no step-up, no shell.
    const mfa = await openShell(a, ep.epId, { profile_id: await profileId(a, 'full_admin') });
    expect(mfa.status).toBe(403);
    expect(mfa.body.error.code).toBe('policy_mfa_not_enrolled');

    const codes = (await audits(a.organizationId, 'fleet.policy_refused')).map((r) => r.metadata.code);
    expect(codes).toEqual(['shell_disabled_by_policy', 'shell_disabled_by_policy', 'shell_admin_only', 'profile_forbids_shell', 'profile_forbids_shell', 'policy_mfa_not_enrolled']);
    expect((await audits(a.organizationId, 'fleet.policy_refused')).every((r) => r.metadata.what === 'shell')).toBe(true);
    expect(await audits(a.organizationId, 'fleet.shell_opened')).toEqual([]);
  });

  it('relays keystrokes and output, seals the transcript, and ends from the operator with every socket closed', async () => {
    const a = await newAccount('shell-live');
    const ep = await shellComputer(a, 'SH-LIVE');
    const full = await profileId(a, 'full_admin');
    const opened = await openShell(a, ep.epId, { profile_id: full, cols: 100, rows: 40 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body).toMatchObject({ state: 'opening', operator_email: a.email, reason: 'Ticket 77: disk full', idle_timeout_s: 900, cols: 100, rows: 40 });
    const shell = opened.body as { id: string; public_id: string };
    const cmd = (await pollFor(ep.cred)).find((c) => c.kind === 'shell_open')!;
    expect(cmd.payload).toMatchObject({ shell_id: shell.public_id, operator: a.email, reason: 'Ticket 77: disk full', cols: 100, rows: 40, idle_timeout_s: 900 });

    const cookie = await loginCookie(a);
    // Another origin, another admin, a wrong shell: refused.
    expect(await refused(operatorSocket(A, cookie, ep.epId, shell.public_id, 'https://evil.example'))).toBe('HTTP 403');
    const other = await addMember(a, 'admin');
    const otherCookie = await loginCookie(other);
    await request(app).post('/api/v1/auth/switch-organization').set('Cookie', otherCookie).set(CSRF).send({ organization_id: a.organizationId });
    expect(await refused(operatorSocket(A, otherCookie, ep.epId, shell.public_id))).toBe('HTTP 403');
    expect(await refused(agentSocket(A, 'ldag_wrong', shell.public_id))).toBe('HTTP 401');

    const agent = await agentSocket(A, ep.cred, shell.public_id);
    agent.ws.send(JSON.stringify({ t: 'hello', shell: 'powershell.exe', pty: 'conpty', cols: 100, rows: 40 }));
    agent.ws.send(Buffer.from('PS C:\\Windows\\system32> '), { binary: true });
    // The operator joins on the other instance: the screen so far comes over pg_notify.
    const op = await operatorSocket(B, cookie, ep.epId, shell.public_id);
    await op.until(() => op.text().includes('PS C:\\Windows\\system32> '), 'prompt');
    await op.until(() => op.texts.find((m) => m.t === 'hello'), 'hello');
    op.ws.send(Buffer.from('Get-PSDrive C\r'), { binary: true });
    await agent.until(() => Buffer.concat(agent.bytes).toString().includes('Get-PSDrive C\r'), 'keystrokes at the agent');
    op.ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 30 }));
    await agent.until(() => agent.texts.find((m) => m.t === 'resize' && m.cols === 120), 'resize');
    agent.ws.send(Buffer.from('Name Used (GB) Free (GB)\r\nC    88.20    11.80\r\n'), { binary: true });
    await op.until(() => op.text().includes('C    88.20'), 'output at the operator');

    const state = await a.agent.get(`/api/v1/endpoints/${ep.epId}/shell/${shell.id}`);
    expect(state.body).toMatchObject({ state: 'open', shell: 'powershell.exe', pty: 'conpty' });

    // End: both sockets close with 4000; the agent gets shell_close too.
    const closed = await a.agent.post(`/api/v1/endpoints/${ep.epId}/shell/${shell.id}/close`).set(CSRF);
    expect(closed.body).toMatchObject({ state: 'closed', end_reason: 'operator', ended_by: a.email });
    await agent.until(() => agent.closed === 4000, 'agent socket closed');
    await op.until(() => op.closed === 4000, 'operator socket closed');
    expect((await pollFor(ep.cred)).find((c) => c.kind === 'shell_close')!.payload).toEqual({ shell_id: shell.public_id, reason: 'operator' });
    expect(await refused(agentSocket(A, ep.cred, shell.public_id))).toBe('HTTP 410');

    // The transcript: everything, in order, decrypted only through the API (admins; audited).
    const t = await a.agent.get(`/api/v1/endpoints/${ep.epId}/shell/${shell.id}/transcript`);
    expect(t.status).toBe(200);
    expect(t.body.unreadable).toBe(0);
    const joined = (t.body.chunks as Array<{ direction: string; text: string }>).map((c) => `${c.direction}:${c.text}`).join('\n');
    expect(joined).toMatch(/^e:opened by .*; reason: Ticket 77: disk full/);
    expect(joined).toContain('o:PS C:\\Windows\\system32> ');
    expect(joined).toContain('i:Get-PSDrive C\r');
    expect(joined).toContain('e:resized to 120x30');
    expect(joined).toContain('C    88.20');
    expect(joined).toMatch(/e:ended: operator$/);
    // At rest it is ciphertext; the plain audit never has a keystroke or a line of output.
    const raw = await systemPool.query<{ c: Buffer }>(`SELECT ciphertext AS c FROM fleet_shell_transcript WHERE shell_id = $1`, [shell.id]);
    expect(raw.rows.length).toBeGreaterThan(3);
    for (const r of raw.rows) expect(r.c.toString('latin1')).not.toContain('Get-PSDrive');
    const all = JSON.stringify((await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1`, [a.organizationId])).rows);
    expect(all).not.toContain('Get-PSDrive');
    expect(all).not.toContain('88.20');
    const openedAudit = (await audits(a.organizationId, 'fleet.shell_opened'))[0]!.metadata;
    expect(openedAudit).toMatchObject({ shell_id: shell.id, profile: 'Full admin', transcript: `/fleet/endpoints/${ep.epId}/shell/${shell.id}` });
    expect((await audits(a.organizationId, 'fleet.shell_closed'))[0]!.metadata).toMatchObject({ end_reason: 'operator', transcript: `/fleet/endpoints/${ep.epId}/shell/${shell.id}` });
    expect(await audits(a.organizationId, 'fleet.shell_transcript_viewed')).toHaveLength(1);
    const counts = await systemPool.query<{ bytes_in: string; bytes_out: string }>(`SELECT bytes_in, bytes_out FROM fleet_shell_sessions WHERE id = $1`, [shell.id]);
    expect(Number(counts.rows[0]!.bytes_in)).toBe('Get-PSDrive C\r'.length);
    // The sealed key is never returned.
    expect(JSON.stringify(state.body)).not.toContain('transcript_key');
  });

  it('ends from the person (End on the bar), on exit, on the size limit, when idle, and when the agent never connects', async () => {
    const a = await newAccount('shell-end');
    const ep = await shellComputer(a, 'SH-END');
    const full = await profileId(a, 'full_admin');

    // The person pressed End on the session bar.
    const s1 = (await openShell(a, ep.epId, { profile_id: full })).body;
    const end = await request(app).post('/api/v1/agent/shell-end').set('Authorization', `Bearer ${ep.cred}`).send({ shell_id: s1.public_id, reason: 'user' });
    expect(end.body.ok).toBe(true);
    expect((await a.agent.get(`/api/v1/endpoints/${ep.epId}/shell/${s1.id}`)).body).toMatchObject({ state: 'closed', end_reason: 'user', ended_by: 'endpoint user' });

    // The shell exited.
    const s2 = (await openShell(a, ep.epId, { profile_id: full })).body;
    const ag2 = await agentSocket(A, ep.cred, s2.public_id);
    ag2.ws.send(JSON.stringify({ t: 'exit', code: 0 }));
    await ag2.until(() => ag2.closed === 4000, 'closed after exit');
    expect((await a.agent.get(`/api/v1/endpoints/${ep.epId}/shell/${s2.id}`)).body).toMatchObject({ end_reason: 'exited', exit_code: 0 });

    // The transcript limit: the shell ends rather than run unrecorded.
    const s3 = (await openShell(a, ep.epId, { profile_id: full })).body;
    await systemPool.query(`UPDATE fleet_shell_sessions SET max_transcript_bytes = 65536 WHERE id = $1`, [s3.id]);
    const ag3 = await agentSocket(A, ep.cred, s3.public_id);
    ag3.ws.send(Buffer.alloc(70_000, 0x41), { binary: true });
    await ag3.until(() => ag3.closed === 4000, 'closed at the limit');
    expect((await a.agent.get(`/api/v1/endpoints/${ep.epId}/shell/${s3.id}`)).body.end_reason).toBe('limit');

    // The agent could not start the shell.
    const s4 = (await openShell(a, ep.epId, { profile_id: full })).body;
    const cmd = (await pollFor(ep.cred)).find((c) => c.kind === 'shell_open' && c.payload.shell_id === s4.public_id)!;
    await request(app)
      .post('/api/v1/agent/command-result')
      .set('Authorization', `Bearer ${ep.cred}`)
      .send({ command_results: [{ id: cmd.id, ok: false, error: 'powershell.exe was not found' }] });
    expect((await a.agent.get(`/api/v1/endpoints/${ep.epId}/shell/${s4.id}`)).body).toMatchObject({ end_reason: 'open_failed', error: 'powershell.exe was not found' });

    // Idle on no instance's watch, and an agent that never connected: the sweep ends both.
    const s5 = (await openShell(a, ep.epId, { profile_id: full })).body;
    const s6 = (await openShell(a, ep.epId, { profile_id: full })).body;
    await systemPool.query(`UPDATE fleet_shell_sessions SET state = 'open', last_activity_at = now() - interval '2 hours' WHERE id = $1`, [s5.id]);
    await systemPool.query(`UPDATE fleet_shell_sessions SET created_at = now() - interval '10 minutes' WHERE id = $1`, [s6.id]);
    expect(await runShellSweep()).toBeGreaterThanOrEqual(2);
    expect((await a.agent.get(`/api/v1/endpoints/${ep.epId}/shell/${s5.id}`)).body.end_reason).toBe('idle');
    expect((await a.agent.get(`/api/v1/endpoints/${ep.epId}/shell/${s6.id}`)).body.end_reason).toBe('open_failed');

    // At most three open shells per computer.
    await openShell(a, ep.epId, { profile_id: full });
    await openShell(a, ep.epId, { profile_id: full });
    await openShell(a, ep.epId, { profile_id: full });
    expect((await openShell(a, ep.epId, { profile_id: full })).body.error.code).toBe('too_many_shells');

    // History and the person's IT activity list name the operator and the reason.
    const list = await a.agent.get(`/api/v1/fleet/shells?endpoint_id=${ep.epId}`);
    expect(list.body.shells.length).toBe(9);
    const act = await request(app).post('/api/v1/agent/it-activity').set('Authorization', `Bearer ${ep.cred}`).send({});
    expect(act.status).toBe(200);
    expect(act.body.items[0]).toMatchObject({ kind: 'shell', by: a.email, what: 'Remote shell', reason: 'Ticket 77: disk full' });
  });
});
