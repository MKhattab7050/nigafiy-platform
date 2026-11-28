import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, app, newAccount } from './helpers.ts';

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
  return { a, epId, send };
}

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
});
