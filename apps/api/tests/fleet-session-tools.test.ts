import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { systemPool } from '../src/infrastructure/db.ts';
import { endpointsModule } from '../src/modules/endpoints/index.ts';
import { openSegment, recordingDir, runRecordingRetention, sealRecord } from '../src/modules/endpoints/remote-desktop/recording.ts';
import { CLOSE_PARTICIPANT_REMOVED, StreamHub, isAudioPacket } from '../src/modules/endpoints/remote-desktop/stream-hub.ts';
import { SEALED_COLUMNS } from '../src/ops/sealed-columns.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, addScope, app, heartbeat, newAccount, newCollector, sweep, telemetry, type TestAccount } from './helpers.ts';

// Fleet Pro in-session tools (migration 036): every tool message goes through the hub only when the
// operator's permissions allow it, is audited without its content, and reaches the agent; session
// recordings are encrypted on disk and play back; several operators each pass the access policy;
// Wake-on-LAN then connect. Real HTTP servers, real `ws` sockets, the real database.

const ORIGIN = 'http://localhost:3100';
const PASSWORD = 'correct horse battery';

class Peer {
  readonly ws: WebSocket;
  readonly texts: Array<Record<string, unknown>> = [];
  readonly binaries: Buffer[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (isBinary) this.binaries.push(buf);
      else this.texts.push(JSON.parse(buf.toString('utf8')));
      for (const w of this.waiters.splice(0)) w();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const w of this.waiters.splice(0)) w();
    });
  }
  async until<T>(check: () => T | undefined | null | false, what: string, ms = 5_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(this.texts.slice(-6))} closed=${JSON.stringify(this.closed)}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }
  text(t: string, pred: (m: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
    return this.until(() => this.texts.find((m) => m.t === t && pred(m)), `"${t}"`);
  }
  send(m: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(m));
  }
}

let server: http.Server;
let hub: StreamHub;
let base = '';

function open(url: string, headers: Record<string, string>): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const p = new Peer(ws);
    ws.once('open', () => resolve(p));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}
const ws = (p: string) => base.replace(/^http/, 'ws') + p;
const agentSocket = (cred: string, session: string) => open(ws(`/api/v1/agent/stream?session=${session}`), { Authorization: `Bearer ${cred}` });
const viewerSocket = (cookie: string, epId: string, session: string) => open(ws(`/api/v1/endpoints/${epId}/remote-desktop/stream?session=${session}`), { Cookie: cookie, Origin: ORIGIN });

async function loginCookie(email: string): Promise<string> {
  const r = await request(app).post('/api/v1/auth/login').set(CSRF).send({ email, password: PASSWORD });
  const c = ((r.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((s) => s.startsWith('ld_session='));
  if (!c) throw new Error(`login: ${r.status}`);
  return c.split(';')[0]!;
}

async function addTechnician(owner: TestAccount) {
  const email = `tech-${Math.random().toString(36).slice(2, 10)}@example.test`;
  const inv = await owner.agent.post('/api/v1/team/invitations').set(CSRF).send({ email, role: 'technician' });
  expect(inv.status).toBe(201);
  const agent = request.agent(app);
  expect((await agent.post(`/api/v1/auth/invitations/${inv.body.token}/accept`).set(CSRF).send({ display_name: 'Tech', password: PASSWORD })).status).toBe(200);
  const id = (await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [email])).rows[0]!.id;
  return { email, agent, id };
}

function packet(seq: number, full: boolean, tile = Buffer.from([0xff, 0xd8, 9, 8, 7, 6, 5, 0xff, 0xd9])): Buffer {
  const header = Buffer.from(
    JSON.stringify({ t: 'frame', seq, full, display: 0, w: 64, h: 64, sw: 64, sh: 64, q: 70, s: 1, fmt: 'jpeg', tiles: [{ x: 0, y: 0, w: 64, h: 64, n: tile.length }], mode: 'test' }),
  );
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([Buffer.from([0x4e, 1]), len, header, tile]);
}

function audioPacket(seq: number): Buffer {
  const header = Buffer.from(JSON.stringify({ t: 'audio', seq, codec: 'ima_adpcm', rate: 48000, ch: 2, frames: 1920, st: [{ p: 0, i: 0 }, { p: 0, i: 0 }] }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([Buffer.from([0x4e, 2]), len, header, Buffer.alloc(1920)]);
}

/** A group whose default and maximum profile is Full admin, unattended (no dialog), with recording rules. */
async function fullAdminGroup(a: TestAccount, epId: string, extra: Record<string, unknown> = {}) {
  const profiles = (await a.agent.get('/api/v1/fleet/profiles')).body.profiles as Array<{ id: string; builtin_key: string | null }>;
  const full = profiles.find((p) => p.builtin_key === 'full_admin')!.id;
  const g = await a.agent
    .post('/api/v1/fleet/groups')
    .set(CSRF)
    .send({ name: `Tools ${Math.random().toString(36).slice(2, 6)}`, access_mode: 'unattended', default_profile_id: full, max_profile_id: full, ...extra });
  expect(g.status).toBe(201);
  await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: g.body.group.id });
  return { group: g.body.group as { id: string }, profiles };
}

const auditRows = async (orgId: string, action: string) =>
  (await systemPool.query(`SELECT user_email, metadata FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at, id`, [orgId, action])).rows;

describe('Fleet Pro in-session tools', () => {
  beforeAll(async () => {
    await endpointsModule.lifecycle.start();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    hub = new StreamHub({ peerUrl: base });
    hub.attach(server);
    hub.start();
  });
  afterAll(async () => {
    await hub.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await endpointsModule.lifecycle.stop();
  });

  it('relays the tools the profile allows, audits them without their content, and refuses the rest', async () => {
    const a = await newAccount('tools');
    const { epId, cred } = await onlineEndpoint(a);
    await fullAdminGroup(a, epId);
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Printer support' });
    expect(start.status).toBe(200);
    const session: string = start.body.session.id;
    expect(start.body.session.operators).toEqual([a.email]);
    const agent = await agentSocket(cred, session);
    const viewer = await viewerSocket(await loginCookie(a.email), epId, session);
    const hello = await viewer.text('session');
    expect(hello.permissions).toMatchObject({ privacy_screen: true, block_input: true, audio: true });
    expect(hello.holder).toBe(true);

    viewer.send({ t: 'privacy', on: true });
    expect((await agent.text('privacy')).on).toBe(true);
    viewer.send({ t: 'block_input', on: true });
    await agent.text('block_input');
    viewer.send({ t: 'sas' });
    await agent.text('sas');
    viewer.send({ t: 'chat', id: 'c1', text: 'Hello, I am fixing the printer driver' });
    expect((await agent.text('chat')).from).toBe(a.email);
    viewer.send({ t: 'ask', id: 'q1', text: 'May I restart the spooler?', kind: 'yes_no' });
    expect(await agent.text('ask')).toMatchObject({ from: a.email, kind: 'yes_no', timeout_s: 300 });
    viewer.send({ t: 'annotate', op: { op: 'stroke', display: { x: 0, y: 0, w: 1920, h: 1080 }, points: [[0.1, 0.1], [0.4, 0.4]] } });
    await agent.text('annotate');
    viewer.send({ t: 'annotate', op: { op: 'stroke', display: { x: 0, y: 0, w: 1920, h: 1080 }, points: [[2, 0.1], [0.4, 0.4]] } });
    expect((await viewer.text('error')).where).toBe('message');
    viewer.send({ t: 'input', ev: { kind: 'key_down', code: 'KeyQ' } });
    expect(((await agent.text('input')).ev as Record<string, unknown>).code).toBe('KeyQ');
    viewer.send({ t: 'input', ev: { kind: 'key_combo', keys: ['ControlLeft', 'ShiftLeft', 'Escape'] } });
    await agent.text('input', (m) => (m.ev as Record<string, unknown>).kind === 'key_combo');
    viewer.send({ t: 'clipboard_set', req: 'p1', format: 'image', data: Buffer.from('png bytes').toString('base64') });
    expect(await agent.text('clipboard_set', (m) => m.format === 'image')).toMatchObject({ data: Buffer.from('png bytes').toString('base64') });
    viewer.send({ t: 'clipboard_get', req: 'f1', format: 'files' });
    const ask = await agent.text('clipboard_get', (m) => m.format === 'files');
    agent.send({ t: 'clipboard', req: ask.req, format: 'files', paths: ['C:\\Users\\u\\report.pdf'] });
    expect((await viewer.text('clipboard', (m) => m.req === 'f1')).paths).toEqual(['C:\\Users\\u\\report.pdf']);

    // The person answers in the chat; every operator sees it; only counts are kept.
    agent.send({ t: 'chat', from: 'user', text: 'my private reply' });
    expect((await viewer.text('chat', (m) => m.from === 'user')).text).toBe('my private reply');
    agent.send({ t: 'answer', id: 'q1', answer: 'yes', text: '' });
    await viewer.text('answer');

    // Audio: on for this operator, packets reach only listeners.
    viewer.send({ t: 'audio', on: true });
    expect((await agent.text('audio')).on).toBe(true);
    expect(isAudioPacket(audioPacket(1))).toBe(true);
    agent.ws.send(audioPacket(1), { binary: true });
    await viewer.until(() => viewer.binaries.find((b) => b[1] === 2), 'an audio packet');
    viewer.send({ t: 'audio', on: false });
    await agent.text('audio', (m) => m.on === false);

    const counts = async () => (await systemPool.query(`SELECT chat_messages, clipboard_to_remote, clipboard_from_remote FROM fleet_sessions WHERE public_id = $1`, [session])).rows[0];
    for (let i = 0; i < 30 && (await counts()).chat_messages < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const row = await counts();
    expect(row).toMatchObject({ chat_messages: 2, clipboard_to_remote: 1, clipboard_from_remote: 1 });
    // The answer is audited (as the endpoint's event) after it was relayed.
    for (let i = 0; i < 40 && (await auditRows(a.organizationId, 'fleet.session_answer')).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    for (const action of ['fleet.session_privacy_screen', 'fleet.session_block_input', 'fleet.session_sas', 'fleet.session_chat', 'fleet.session_question', 'fleet.session_annotation', 'fleet.session_audio', 'fleet.session_answer']) {
      expect((await auditRows(a.organizationId, action)).length, action).toBeGreaterThan(0);
    }
    const all = JSON.stringify((await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1`, [a.organizationId])).rows);
    for (const secret of ['fixing the printer driver', 'restart the spooler', 'my private reply', 'KeyQ', 'Escape', 'png bytes', Buffer.from('png bytes').toString('base64')]) {
      expect(all, secret).not.toContain(secret);
    }
    expect((await auditRows(a.organizationId, 'fleet.session_chat'))[0]!.metadata.chars).toBe('Hello, I am fixing the printer driver'.length);
    agent.ws.close();
    viewer.ws.close();
  });

  it('refuses privacy screen, input block, audio and Ctrl+Alt+Del when the profile does not allow them', async () => {
    const a = await newAccount('tools-view');
    const { epId, cred } = await onlineEndpoint(a);
    const profiles = (await a.agent.get('/api/v1/fleet/profiles')).body.profiles as Array<{ id: string; builtin_key: string | null }>;
    const viewOnly = profiles.find((p) => p.builtin_key === 'view_only')!.id;
    const g = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'View', access_mode: 'unattended', default_profile_id: viewOnly });
    await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ endpoint_ids: [epId], fleet_group_id: g.body.group.id });
    const session = (await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Look only' })).body.session.id as string;
    const agent = await agentSocket(cred, session);
    const viewer = await viewerSocket(await loginCookie(a.email), epId, session);
    await viewer.text('session');
    for (const [msg, code] of [
      [{ t: 'privacy', on: true }, 'profile_forbids_privacy_screen'],
      [{ t: 'block_input', on: true }, 'profile_forbids_block_input'],
      [{ t: 'audio', on: true }, 'profile_forbids_audio'],
      [{ t: 'sas' }, 'profile_forbids_control'],
    ] as const) {
      viewer.send(msg);
      expect((await viewer.text('tool_error', (m) => m.code === code)).code).toBe(code);
    }
    viewer.send({ t: 'clipboard_get', req: 'i1', format: 'image' });
    expect((await viewer.text('clipboard_error', (m) => m.req === 'i1')).code).toBe('profile_forbids_clipboard_out');
    viewer.send({ t: 'ack', seq: 1 });
    await agent.text('ack');
    expect(agent.texts.some((m) => ['privacy', 'block_input', 'audio', 'sas', 'clipboard_get'].includes(m.t as string))).toBe(false);
    const refused = (await auditRows(a.organizationId, 'fleet.session_refused_action')).map((r) => r.metadata.code);
    expect(refused).toEqual(expect.arrayContaining(['profile_forbids_privacy_screen', 'profile_forbids_block_input', 'profile_forbids_audio', 'profile_forbids_control']));
    // The built-in View only profile may be recorded (group mode "optional"): on, banner told, off.
    const rec = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/recording`).set(CSRF).send({ on: true });
    expect(rec.status).toBe(200);
    expect(rec.body.recording_id).toMatch(/^[0-9a-f-]{36}$/);
    await viewer.text('recording', (m) => m.on === true);
    const upd = (await systemPool.query(`SELECT payload FROM endpoint_commands WHERE endpoint_id = $1 AND kind = 'rd_session_update' ORDER BY created_at DESC LIMIT 1`, [epId])).rows[0]!.payload;
    expect(upd).toMatchObject({ session_id: session, recording: true, operators: [a.email] });
    const offRes = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/recording`).set(CSRF).send({ on: false });
    expect(offRes.body.recording_id).toBeNull();
    expect((await auditRows(a.organizationId, 'fleet.recording_started')).length).toBe(1);
    expect((await auditRows(a.organizationId, 'fleet.recording_stopped')).length).toBe(1);
    agent.ws.close();
    viewer.ws.close();
  });

  it('records frames and input timing encrypted, plays them back, and deletes them at retention', async () => {
    const a = await newAccount('tools-rec');
    const { epId, cred } = await onlineEndpoint(a);
    expect(SEALED_COLUMNS.some((c) => c.table === 'fleet_recordings' && c.column === 'key_sealed')).toBe(true);
    const { group } = await fullAdminGroup(a, epId, { recording_mode: 'off' });
    // A group that forbids recording refuses a recorded session.
    const off = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Recorded fix', recording_enabled: true });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('recording_disabled_by_policy');
    await a.agent.patch(`/api/v1/fleet/groups/${group.id}`).set(CSRF).send({ recording_mode: 'required', recording_retention_days: 7 });
    // The connect dialog's preview shows the rule.
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/policy`)).body).toMatchObject({ recording_mode: 'required', recording_retention_days: 7 });

    // Required: recorded even though the operator did not ask.
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Recorded fix' });
    expect(start.status).toBe(200);
    const session: string = start.body.session.id;
    const recId: string = start.body.session.recording_id;
    expect(recId).toMatch(/^[0-9a-f-]{36}$/);
    const open = (await systemPool.query(`SELECT payload FROM endpoint_commands WHERE endpoint_id = $1 AND kind = 'rd_session_open'`, [epId])).rows[0]!.payload;
    expect(open).toMatchObject({ recording: true, operators: [a.email] });

    const agent = await agentSocket(cred, session);
    const viewer = await viewerSocket(await loginCookie(a.email), epId, session);
    expect((await viewer.text('session')).recording).toBe(true);
    await agent.text('full');
    agent.ws.send(packet(1, true), { binary: true });
    await viewer.until(() => viewer.binaries[0], 'a frame');
    viewer.send({ t: 'input', ev: { kind: 'key_press', key: 'S' } });
    viewer.send({ t: 'input', ev: { kind: 'mouse_click', x: 0.25, y: 0.75 } });
    await agent.text('input', (m) => (m.ev as Record<string, unknown>).kind === 'mouse_click');
    // Stopping is refused while the policy requires recording.
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/recording`).set(CSRF).send({ on: false })).body.error.code).toBe('recording_required_by_policy');
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF);
    await viewer.until(() => viewer.closed, 'the viewer closed');

    // The hub closes the writer when the session ends.
    await new Promise((r) => setTimeout(r, 300));
    const row = (await systemPool.query(`SELECT state, frames, input_events, key_sealed FROM fleet_recordings WHERE id = $1`, [recId])).rows[0];
    expect(row.state).toBe('complete');
    expect(Number(row.frames)).toBeGreaterThanOrEqual(1);
    expect(Number(row.input_events)).toBe(2);
    expect(row.key_sealed).toMatch(/^v1:/);

    // On disk: encrypted (the tile bytes are not there in clear).
    const dir = recordingDir(a.organizationId, recId);
    const files = fs.readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    const raw = fs.readFileSync(path.join(dir, files[0]!));
    expect(raw.includes(Buffer.from([9, 8, 7, 6, 5]))).toBe(false);
    expect(raw.toString('latin1')).not.toContain('"frame"');

    // The API never returns the key; the detail has segments and the audit timeline.
    const detail = await a.agent.get(`/api/v1/fleet/recordings/${recId}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain('key_sealed');
    expect(detail.body.timeline.map((t: { action: string }) => t.action)).toContain('fleet.session_requested');
    const seg = detail.body.segments[0].name as string;
    const play = await a.agent.get(`/api/v1/fleet/recordings/${recId}/segments/${seg}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(play.status).toBe(200);
    const body = play.body as Buffer;
    const records: Array<{ type: number; payload: Buffer }> = [];
    for (let off = 0; off < body.length; ) {
      const len = body.readUInt32BE(off);
      records.push({ type: body[off + 4]!, payload: body.subarray(off + 13, off + 4 + len) });
      off += 4 + len;
    }
    const frame = records.find((r) => r.type === 1)!;
    expect(frame.payload.equals(packet(1, true))).toBe(true);
    const inputs = records.filter((r) => r.type === 2).map((r) => JSON.parse(r.payload.toString()));
    expect(inputs).toEqual([{ k: 'key' }, { k: 'mouse_click', d: 0, x: 0.25, y: 0.75 }]);
    expect(JSON.stringify(inputs)).not.toContain('"S"');

    // A record moved to another recording fails authentication.
    const key = Buffer.alloc(32, 7);
    const sealed = sealRecord(key, 'rec-a|seg', 1, Date.now(), Buffer.from('x'));
    const file = Buffer.concat([Buffer.from('NREC1\n'), sealed]);
    expect(openSegment(key, 'rec-a|seg', file).records).toHaveLength(1);
    expect(openSegment(key, 'rec-b|seg', file).error).toMatch(/authentication/);

    // Retention: past its date the file goes, the row stays marked deleted (and audited).
    await systemPool.query(`UPDATE fleet_recordings SET retention_until = now() - interval '1 minute' WHERE id = $1`, [recId]);
    await runRecordingRetention();
    expect(fs.existsSync(dir)).toBe(false);
    expect((await systemPool.query(`SELECT state, delete_reason FROM fleet_recordings WHERE id = $1`, [recId])).rows[0]).toEqual({ state: 'deleted', delete_reason: 'retention' });
    expect((await auditRows(a.organizationId, 'fleet.recording_deleted')).length).toBe(1);
    agent.ws.close();
  });

  it('lets a colleague join only by invitation, through the policy, with their own permissions; hand-over and removal', async () => {
    const a = await newAccount('tools-multi');
    const b = await addTechnician(a);
    const { epId, cred } = await onlineEndpoint(a);
    await fullAdminGroup(a, epId);
    const session = (await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Two of us' })).body.session.id as string;
    const agent = await agentSocket(cred, session);
    const bCookie = await loginCookie(b.email);
    // Not invited: no picture.
    await expect(viewerSocket(bCookie, epId, session)).rejects.toThrow('HTTP 403');
    expect((await b.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants/join`).set(CSRF).send({})).body.error.code).toBe('not_invited');
    // Nor through the HTTP fallback: rd_capture and rd_input are for participants only (audited).
    for (const kind of ['rd_capture', 'rd_input']) {
      const r = await b.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send(kind === 'rd_input' ? { kind, event_kind: 'key_press', key: 'Enter' } : { kind });
      expect([r.status, r.body.error?.code], kind).toEqual([403, 'not_a_participant']);
    }

    const viewOnly = { view: true, control: false, clipboard_in: false, clipboard_out: false, files: false, audio: false, record: false, restart: false, privacy_screen: false, block_input: false, shell: false };
    const inv = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants`).set(CSRF).send({ user_id: b.id, permissions: viewOnly });
    expect(inv.status).toBe(200);
    expect(inv.body.participant.state).toBe('invited');
    // Only the holder (or an admin) invites.
    expect((await b.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants`).set(CSRF).send({ user_id: b.id })).status).toBe(403);
    const joined = await b.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants/join`).set(CSRF).send({});
    expect(joined.status).toBe(200);
    expect(joined.body.participant).toMatchObject({ state: 'joined', permissions: { view: true, control: false } });
    const update = (await systemPool.query(`SELECT payload FROM endpoint_commands WHERE endpoint_id = $1 AND kind = 'rd_session_update' ORDER BY created_at DESC LIMIT 1`, [epId])).rows[0]!.payload;
    expect(update.operators).toEqual([a.email, b.email]);

    const bView = await viewerSocket(bCookie, epId, session);
    expect((await bView.text('session')).permissions).toMatchObject({ view: true, control: false });
    bView.send({ t: 'input', ev: { kind: 'mouse_click', x: 0.5, y: 0.5 } });
    expect((await bView.text('input_error')).code).toBe('profile_forbids_control');
    expect(agent.texts.some((m) => m.t === 'input')).toBe(false);
    const list = (await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/participants`)).body.participants as Array<{ email: string; role: string }>;
    expect(list.map((p) => [p.email, p.role])).toEqual([
      [a.email, 'holder'],
      [b.email, 'colleague'],
    ]);

    // Hand over: b holds the session; a stays in it.
    const ho = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants/${b.id}/handover`).set(CSRF);
    expect(ho.status).toBe(200);
    expect(ho.body.session.operator_email).toBe(b.email);
    expect(JSON.stringify(ho.body)).not.toContain('operator_user_id');
    expect((await systemPool.query(`SELECT operator_email FROM fleet_sessions WHERE public_id = $1`, [session])).rows[0]!.operator_email).toBe(b.email);
    // The holder cannot be removed; b removes a, whose socket closes.
    const aId = (await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [a.email])).rows[0]!.id;
    const aView = await viewerSocket(await loginCookie(a.email), epId, session);
    await aView.text('session');
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants/${b.id}/remove`).set(CSRF)).body.error.code).toBe('holder_cannot_leave');
    expect((await b.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/participants/${aId}/remove`).set(CSRF)).status).toBe(200);
    await aView.until(() => aView.closed?.code === CLOSE_PARTICIPANT_REMOVED, 'a removed');
    for (const action of ['fleet.participant_invited', 'fleet.participant_joined', 'fleet.session_handed_over', 'fleet.participant_removed']) {
      expect((await auditRows(a.organizationId, action)).length, action).toBe(1);
    }
    agent.ws.close();
    bView.ws.close();
  });

  it('wakes an offline computer through the Sensor, then the session starts when it is online; timeouts are clear', async () => {
    const a = await newAccount('tools-wake');
    const scopeId = await addScope(a, '192.168.9.0/24');
    const c = await newCollector(a);
    await heartbeat(c);
    await telemetry(c, [sweep(scopeId, [{ ip: '192.168.9.20', mac: '00:0c:29:99:00:20', hostname: 'desk-20' }], 1)]);
    const device = ((await a.agent.get('/api/v1/devices?sort=ip')).body.items as Array<{ id: string; current_ip: string }>).find((d) => d.current_ip === '192.168.9.20')!;
    const { epId, cred } = await onlineEndpoint(a, 'DESK-20');
    // Online: connect directly.
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/wake`).set(CSRF).send({ reason: 'After hours fix' })).body.error.code).toBe('endpoint_online');
    await systemPool.query(`UPDATE endpoints SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [epId]);
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/wake`).set(CSRF).send({ reason: 'After hours fix' })).body.error.code).toBe('no_device');
    await systemPool.query(`UPDATE endpoints SET device_id = $2 WHERE id = $1`, [epId, device.id]);

    const w = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/wake`).set(CSRF).send({ reason: 'After hours fix', timeout_s: 120 });
    expect(w.status).toBe(200);
    expect(w.body.wake).toMatchObject({ state: 'waking', mac: '00:0c:29:99:00:20', broadcast: '192.168.9.255' });
    const sent = (await heartbeat(c)).body.commands.find((x: { kind: string }) => x.kind === 'wake_device');
    expect(sent.payload).toEqual({ mac: '00:0c:29:99:00:20', broadcast: '192.168.9.255' });
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/wake`)).body.wake.state).toBe('waking');

    // The agent comes back: the request turns online; the console starts the session with it.
    await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${cred}`)
      .send({ agent_version: '0.3.0', hostname: 'DESK-20', os: 'windows', arch: 'amd64', uptime_seconds: 5, cpu_pct: 1, ram_used_mb: 900, ram_pct: 10 });
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/wake`)).body.wake.state).toBe('online');
    const start = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'After hours fix', wake_request_id: w.body.wake.id });
    expect(start.status).toBe(200);
    const after = (await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/wake`)).body.wake;
    expect(after).toMatchObject({ state: 'connected', session_public_id: start.body.session.id });
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/stop`).set(CSRF);

    // A computer that never comes back: timed out.
    await systemPool.query(`UPDATE endpoints SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [epId]);
    const w2 = await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/wake`).set(CSRF).send({ reason: 'Second try', timeout_s: 60 });
    await systemPool.query(`UPDATE fleet_wake_requests SET timeout_at = now() - interval '1 second' WHERE id = $1`, [w2.body.wake.id]);
    expect((await a.agent.get(`/api/v1/endpoints/${epId}/remote-desktop/wake`)).body.wake.state).toBe('timed_out');
    expect((await auditRows(a.organizationId, 'fleet.wake_requested')).length).toBe(2);
  });

  it('audits printing and drag-and-drop transfers by name, size and hash only, per the files permission', async () => {
    const a = await newAccount('tools-print');
    const { epId } = await onlineEndpoint(a);
    await fullAdminGroup(a, epId);
    await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/start`).set(CSRF).send({ reason: 'Print a report' });
    const sha = 'a'.repeat(64);
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/print`).set(CSRF).send({ name: 'report.pdf', bytes: 1234, sha256: sha, mime: 'application/pdf' })).status).toBe(200);
    expect(
      (await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/transfer`).set(CSRF).send({ direction: 'to_remote', via: 'drag_drop', name: 'setup.msi', bytes: 99, sha256: sha })).status,
    ).toBe(200);
    expect((await a.agent.post(`/api/v1/endpoints/${epId}/remote-desktop/transfer`).set(CSRF).send({ direction: 'to_remote', via: 'drag_drop', name: 'x', bytes: 1, sha256: 'nope' })).status).toBe(400);
    expect((await auditRows(a.organizationId, 'fleet.session_print'))[0]!.metadata).toMatchObject({ name: 'report.pdf', bytes: 1234, sha256: sha });
    expect((await systemPool.query(`SELECT files_transferred FROM fleet_sessions WHERE endpoint_id = $1`, [epId])).rows[0]!.files_transferred).toBe(1);
  });
});
