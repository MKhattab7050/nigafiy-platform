import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, app, newAccount, setRole } from './helpers.ts';

// The file manager's transfers: chunk sizes the API accepts, the walk op, and the transfer limiter.

async function enrolledWindows(prefix: string) {
  const a = await newAccount(prefix);
  const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'Files PC', platform: 'windows' });
  const enrolled = await request(app).post('/api/v1/agent/enroll').send({
    enrollment_token: created.body.enrollment_token,
    hostname: 'FILES-01',
    agent_version: '0.4.0',
    os: 'windows',
    arch: 'amd64',
  });
  expect(enrolled.status).toBe(201);
  const cred: string = enrolled.body.credential;
  const hb = () =>
    request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${cred}`)
      .send({ agent_version: '0.4.0', hostname: 'FILES-01', os: 'windows', arch: 'amd64', cpu_pct: 5, ram_used_mb: 2048, ram_pct: 30, disk_used_pct: 41.5 });
  expect((await hb()).status).toBe(200);
  const epId = created.body.endpoint.id as string;
  const send = (body: Record<string, unknown>) => a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'fs_op', ...body });
  const asAgent = (r: request.Test) => r.set('Authorization', `Bearer ${cred}`);
  const poll = (features?: string[]) => asAgent(request(app).post('/api/v1/agent/poll')).send(features ? { features } : {});
  return { a, epId, send, hb, cred, asAgent, poll };
}

const piece = (n: number, fill = 9) => Buffer.alloc(n, fill);
const OCTET = { 'Content-Type': 'application/octet-stream' };
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const parts: Buffer[] = [];
    res.on('data', (c: Buffer) => parts.push(c));
    res.on('end', () => cb(null, Buffer.concat(parts)));
  });

describe('file transfers', () => {
  it('accepts a full 1 MiB upload chunk (the user API takes larger bodies on the commands route only)', async () => {
    const { send } = await enrolledWindows('ft-chunk');
    const data = Buffer.alloc(1024 * 1024, 7).toString('base64');
    const res = await send({ op: 'upload', path: 'C:\\Users\\Public\\big.bin', offset: 0, data_base64: data });
    expect(res.status).toBe(202);
    // The audit and the stored payload never keep the bytes.
    expect(JSON.stringify(res.body)).not.toContain(data.slice(0, 64));

    // Other routes keep the small body limit.
    const a = (await newAccount('ft-chunk-other')).agent;
    const big = await a.post('/api/v1/endpoints').set(CSRF).send({ name: 'x'.repeat(200_000) });
    expect(big.status).toBe(413);
  });

  it('accepts a download of 1 MiB per chunk and the walk op', async () => {
    const { send } = await enrolledWindows('ft-walk');
    expect((await send({ op: 'download', path: 'C:\\Users\\Public\\big.bin', offset: 0, length: 1024 * 1024 })).status).toBe(202);
    expect((await send({ op: 'download', path: 'C:\\Users\\Public\\big.bin', offset: 0, length: 4 * 1024 * 1024 })).status).toBe(400);
    const walk = await send({ op: 'walk', path: 'C:\\Users\\Public' });
    expect(walk.status).toBe(202);
    expect(walk.body.payload.op).toBe('walk');
  });

  it('audits a transfer at its start and its end, not every chunk', async () => {
    const { a, send } = await enrolledWindows('ft-audit');
    const path = 'C:UsersPublicmovie.mkv';
    const chunk = Buffer.alloc(1000, 1).toString('base64');
    expect((await send({ op: 'upload', path, offset: 0, data_base64: chunk })).status).toBe(202);
    for (const offset of [1000, 2000, 3000]) expect((await send({ op: 'upload', path, offset, data_base64: chunk })).status).toBe(202);
    expect((await send({ op: 'upload', path, offset: 4000, data_base64: chunk, expected_sha256: 'a'.repeat(64) })).status).toBe(202);
    expect((await send({ op: 'download', path, offset: 0, length: 1000 })).status).toBe(202);
    expect((await send({ op: 'download', path, offset: 1000, length: 1000 })).status).toBe(202);
    expect((await send({ op: 'hash', path, size_only: true })).status).toBe(202);
    expect((await send({ op: 'list', path, size_only: true })).status).toBe(400);
    const rows = (
      await systemPool.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'endpoint.fs_op' ORDER BY created_at`, [a.organizationId])
    ).rows;
    expect(rows.map((r) => [r.metadata.op, r.metadata.offset ?? 0])).toEqual([
      ['upload', 0],
      ['upload', 4000],
      ['download', 0],
    ]);
  });

  it('lets the operator who sent a file command wait for its result, and nobody else', async () => {
    const { a, epId, send } = await enrolledWindows('ft-get');
    const sent = await send({ op: 'walk', path: 'C:UsersPublic' });
    const got = await a.agent.get(`/api/v1/endpoints/${epId}/commands/${sent.body.id}?wait_ms=50`);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe('pending');
    const other = await newAccount('ft-get-other');
    expect((await other.agent.get(`/api/v1/endpoints/${epId}/commands/${sent.body.id}`)).status).toBe(404);
  });
  it('drops the transport rows of a transfer and any uncollected bytes after 10 minutes', async () => {
    const { epId, send, hb } = await enrolledWindows('ft-prune');
    const bytes = Buffer.alloc(2000, 3).toString('base64');
    const ids: Record<string, string> = {};
    const q = async (name: string, body: Record<string, unknown>) => {
      const r = await send(body);
      expect(r.status).toBe(202);
      ids[name] = r.body.id;
    };
    await q('first', { op: 'download', path: 'C:\\Users\\Public\\a.bin', offset: 0, length: 1024 });
    await q('middle', { op: 'download', path: 'C:\\Users\\Public\\a.bin', offset: 1024, length: 1024 });
    await q('upMiddle', { op: 'upload', path: 'C:\\Users\\Public\\b.bin', offset: 2000, data_base64: bytes });
    await q('upStart', { op: 'upload', path: 'C:\\Users\\Public\\c.bin', offset: 0, data_base64: bytes });
    await q('walk', { op: 'walk', path: 'C:\\Users\\Public' });
    // Twenty minutes later: the downloads finished but nobody collected the first one's bytes; the
    // uploads expired undelivered.
    await systemPool.query(`UPDATE endpoint_commands SET created_at = now() - interval '20 minutes' WHERE endpoint_id = $1`, [epId]);
    await systemPool.query(
      `UPDATE endpoint_commands SET status = 'completed', completed_at = now(), result_data = '{"data_base64":"QUJD","eof":false}'::jsonb
        WHERE endpoint_id = $1 AND payload->>'op' IN ('download', 'walk')`,
      [epId],
    );
    expect((await hb()).status).toBe(200);
    const rows = (await systemPool.query<{ id: string; status: string; payload: Record<string, unknown>; result_data: Record<string, unknown> | null }>(`SELECT id, status, payload, result_data FROM endpoint_commands WHERE endpoint_id = $1`, [epId])).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.has(ids.middle!)).toBe(false);
    expect(byId.has(ids.upMiddle!)).toBe(false);
    expect(byId.has(ids.walk!)).toBe(false);
    // The start of each transfer stays (it is the audited one), without the bytes.
    expect(byId.get(ids.first!)?.result_data).toEqual({ eof: false });
    expect(byId.get(ids.upStart!)?.status).toBe('expired');
    expect(byId.get(ids.upStart!)?.payload.data_base64).toBeUndefined();
  });

  describe('binary side channel (fs_relay)', () => {
    const upload = (a: Awaited<ReturnType<typeof newAccount>>, epId: string, body: Buffer) => a.agent.post(`/api/v1/endpoints/${epId}/file-data`).set(CSRF).set(OCTET).send(body);

    it('takes an upload piece from an admin only, raw, at most 2 MiB, for its own endpoint', async () => {
      const { a, epId } = await enrolledWindows('fr-up');
      const ok = await upload(a, epId, piece(1024 * 1024));
      expect(ok.status).toBe(201);
      expect(ok.body.size).toBe(1024 * 1024);
      expect(ok.body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await upload(a, epId, piece(2 * 1024 * 1024 + 1))).status).toBe(413);
      expect((await upload(a, epId, Buffer.alloc(0))).status).toBe(400);
      const other = await newAccount('fr-up-other');
      expect((await upload(other, epId, piece(10))).status).toBe(404);
      await setRole(a.email, a.organizationId, 'technician');
      expect((await upload(a, epId, piece(10))).status).toBe(403);
    });

    it('gives an old agent the bytes inside the command, as before', async () => {
      const { a, epId, send, poll } = await enrolledWindows('fr-old');
      expect((await poll()).status).toBe(200);
      const up = await upload(a, epId, piece(3000, 5));
      const cmd = await send({ op: 'upload', path: 'C:\\x.bin', offset: 0, data_ref: up.body.id });
      expect(cmd.status).toBe(202);
      const row = (await systemPool.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM endpoint_commands WHERE id = $1`, [cmd.body.id])).rows[0]!;
      expect(row.payload.data_ref).toBeUndefined();
      // (the stored payload drops the bytes once delivered; here it is still queued)
      expect(Buffer.from(String(row.payload.data_base64), 'base64').equals(piece(3000, 5))).toBe(true);
      expect((await systemPool.query(`SELECT 1 FROM file_relay WHERE id = $1`, [up.body.id])).rowCount).toBe(0);
      // A download does not ask an old agent for the side channel.
      const dl = await send({ op: 'download', path: 'C:\\x.bin', offset: 0, length: 1024, relay: true });
      expect(dl.status).toBe(202);
      const dlRow = (await systemPool.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM endpoint_commands WHERE id = $1`, [dl.body.id])).rows[0]!;
      expect(dlRow.payload.relay).toBeUndefined();
    });

    it('moves the bytes apart with an agent that announced fs_relay, read once by the operator who asked', async () => {
      const { a, epId, send, poll, asAgent } = await enrolledWindows('fr-new');
      expect((await poll(['fs_relay'])).status).toBe(200);
      // Upload: the command keeps the reference; the agent fetches the bytes raw.
      const up = await upload(a, epId, piece(4000, 6));
      const cmd = await send({ op: 'upload', path: 'C:\\y.bin', offset: 0, data_ref: up.body.id });
      expect(cmd.status).toBe(202);
      expect(cmd.body.payload.data_len).toBe(4000);
      const got = await binary(asAgent(request(app).get(`/api/v1/agent/file-data/${up.body.id}`)));
      expect(got.status).toBe(200);
      expect((got.body as Buffer).equals(piece(4000, 6))).toBe(true);
      // Another device cannot read it, nor use it.
      const stranger = await enrolledWindows('fr-new-stranger');
      expect((await stranger.asAgent(request(app).get(`/api/v1/agent/file-data/${up.body.id}`))).status).toBe(404);
      const theirs = await upload(stranger.a, stranger.epId, piece(10));
      expect([404, 409]).toContain((await send({ op: 'upload', path: 'C:\\z.bin', offset: 0, data_ref: theirs.body.id })).status);
      // The piece goes when its command ends; the reference is then refused.
      const done = await asAgent(request(app).post('/api/v1/agent/command-result')).send({ command_results: [{ id: cmd.body.id, ok: true, data: { size: 4000 } }] });
      expect(done.status).toBe(200);
      expect((await systemPool.query(`SELECT 1 FROM file_relay WHERE id = $1`, [up.body.id])).rowCount).toBe(0);
      expect((await send({ op: 'upload', path: 'C:\\y.bin', offset: 4000, data_ref: up.body.id })).status).toBe(409);

      // Download: the agent sends the bytes apart, the result says so.
      const dl = await send({ op: 'download', path: 'C:\\y.bin', offset: 0, length: 4000, relay: true });
      expect(dl.status).toBe(202);
      expect(dl.body.payload.relay).toBe(true);
      const sent = await asAgent(request(app).post(`/api/v1/agent/file-data?command_id=${dl.body.id}`)).set(OCTET).send(piece(4000, 7));
      expect(sent.status).toBe(201);
      await asAgent(request(app).post('/api/v1/agent/command-result')).send({ command_results: [{ id: dl.body.id, ok: true, data: { offset: 0, relayed: true, eof: true } }] });
      // Not for another organization.
      const second = await newAccount('fr-new-second');
      expect((await second.agent.get(`/api/v1/endpoints/${epId}/commands/${dl.body.id}/data`)).status).toBe(404);
      const read = await binary(a.agent.get(`/api/v1/endpoints/${epId}/commands/${dl.body.id}/data`));
      expect(read.status).toBe(200);
      expect((read.body as Buffer).equals(piece(4000, 7))).toBe(true);
      expect((await a.agent.get(`/api/v1/endpoints/${epId}/commands/${dl.body.id}/data`)).status).toBe(404);
      // A finished download takes no more bytes.
      expect((await asAgent(request(app).post(`/api/v1/agent/file-data?command_id=${dl.body.id}`)).set(OCTET).send(piece(10))).status).toBe(404);
    });

    it('sweeps pieces nobody collected after 10 minutes', async () => {
      const { a, epId, hb } = await enrolledWindows('fr-sweep');
      const up = await upload(a, epId, piece(100));
      await systemPool.query(`UPDATE file_relay SET created_at = now() - interval '11 minutes' WHERE id = $1`, [up.body.id]);
      expect((await hb()).status).toBe(200);
      expect((await systemPool.query(`SELECT 1 FROM file_relay WHERE id = $1`, [up.body.id])).rowCount).toBe(0);
    });
  });
});
