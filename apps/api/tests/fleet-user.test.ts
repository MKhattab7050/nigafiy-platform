import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount } from './helpers.ts';

// Fleet Pro, the user's side (migration 043): the tray's "Past recordings…" (only when the group
// allows it; short-lived token links stored as SHA-256; first use audited), and the IT activity
// list now naming file transfers and update installs. No policy field can hide the tray.

const hb = (cred: string) =>
  request(app)
    .post('/api/v1/agent/heartbeat')
    .set('Authorization', `Bearer ${cred}`)
    .send({ agent_version: '0.3.0', hostname: 'USER-PC', os: 'windows', arch: 'amd64', uptime_seconds: 60, cpu_pct: 5, ram_used_mb: 1000, ram_pct: 20 });

async function addRecording(org: string, ep: string): Promise<string> {
  const fsess = (
    await systemPool.query<{ id: string }>(
      `INSERT INTO fleet_sessions (organization_id, endpoint_id, public_id, state, consent_mode, operator_email, reason) VALUES ($1, $2, $3, 'ended', 'unattended', 'it@example.test', 'printer') RETURNING id`,
      [org, ep, `pub-user-${Math.random().toString(36).slice(2)}`],
    )
  ).rows[0]!.id;
  return (
    await systemPool.query<{ id: string }>(
      `INSERT INTO fleet_recordings (organization_id, endpoint_id, fleet_session_id, session_public_id, key_sealed, retention_days, retention_until, state, segments)
       VALUES ($1, $2, $3, 'pub', 'placeholder', 30, now() + interval '30 days', 'complete', 1) RETURNING id`,
      [org, ep, fsess],
    )
  ).rows[0]!.id;
}

describe('fleet: the user side of the tray', () => {
  it('past recordings: off unless the group allows it; links expire, are hashed, and their first use is audited', async () => {
    const a = await newAccount('user-rec');
    const { epId, cred } = await onlineEndpoint(a, 'USER-PC');
    const agent = (path: string, body: Record<string, unknown> = {}) => request(app).post(`/api/v1/agent${path}`).set('Authorization', `Bearer ${cred}`).send(body);
    const recId = await addRecording(a.organizationId, epId);

    // No group (and a group by default): the tray hides "Past recordings…" and the server refuses.
    expect((await hb(cred)).body.tray).toEqual({ recordings: false });
    expect((await agent('/recordings')).body).toEqual({ allowed: false, recordings: [] });
    expect((await agent('/recordings/link', { recording_id: recId })).status).toBe(403);

    const g = await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: 'Office', user_may_view_recordings: true });
    expect(g.status).toBe(201);
    await a.agent.post('/api/v1/fleet/groups/assign').set(CSRF).send({ fleet_group_id: g.body.group.id, endpoint_ids: [epId] });
    expect((await hb(cred)).body.tray).toEqual({ recordings: true });

    const list = await agent('/recordings');
    expect(list.body.allowed).toBe(true);
    expect(list.body.recordings.map((r: { id: string }) => r.id)).toEqual([recId]);
    expect(list.body.recordings[0].operator).toBe('it@example.test');

    expect((await agent('/recordings/link', { recording_id: recId, extra: 1 })).status).toBe(400);
    const link = await agent('/recordings/link', { recording_id: recId, user: 'PC\\sara' });
    expect(link.status).toBe(200);
    expect(link.body.path).toMatch(/^\/recording-view\/[A-Za-z0-9_-]{40,64}$/);
    const token = link.body.path.split('/').pop() as string;
    // Only the hash is stored.
    const stored = await systemPool.query<{ token_hash: string }>(`SELECT token_hash FROM fleet_recording_user_links WHERE recording_id = $1`, [recId]);
    expect(stored.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]!.token_hash).not.toContain(token);

    // A part cannot be read before the page was opened.
    const seg = `/api/v1/recording-links/${token}/segments/seg-1700000000000.nrec`;
    expect((await request(app).get(seg)).status).toBe(409);

    const page = await request(app).get(`/api/v1/recording-links/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body.recording).toMatchObject({ id: recId, endpoint_name: 'USER-PC', reason: 'printer' });
    await request(app).get(`/api/v1/recording-links/${token}`);
    const audit = await systemPool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action IN ('fleet.recording_user_link', 'fleet.recording_viewed_by_user') ORDER BY created_at`,
      [a.organizationId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['fleet.recording_user_link', 'fleet.recording_viewed_by_user']);
    // After opening, a missing part is a plain 404.
    expect((await request(app).get(seg)).status).toBe(404);

    // The group stops allowing it: the open link stops working at once.
    await a.agent.patch(`/api/v1/fleet/groups/${g.body.group.id}`).set(CSRF).send({ user_may_view_recordings: false });
    expect((await request(app).get(`/api/v1/recording-links/${token}`)).status).toBe(403);
    await a.agent.patch(`/api/v1/fleet/groups/${g.body.group.id}`).set(CSRF).send({ user_may_view_recordings: true });

    // An unopened link past 15 minutes, and an opened one past 4 hours, are gone (410).
    const late = (await agent('/recordings/link', { recording_id: recId })).body.path.split('/').pop() as string;
    await systemPool.query(`UPDATE fleet_recording_user_links SET expires_at = now() - interval '1 minute' WHERE first_used_at IS NULL`);
    expect((await request(app).get(`/api/v1/recording-links/${late}`)).status).toBe(410);
    await systemPool.query(`UPDATE fleet_recording_user_links SET expires_at = now() - interval '5 hours', first_used_at = now() - interval '5 hours' WHERE recording_id = $1`, [recId]);
    expect((await request(app).get(`/api/v1/recording-links/${token}`)).status).toBe(410);
    expect((await request(app).get('/api/v1/recording-links/short')).status).toBe(404);

    // Another computer's recording cannot be linked.
    const other = await onlineEndpoint(a, 'OTHER-PC');
    const otherRec = await addRecording(a.organizationId, other.epId);
    expect((await agent('/recordings/link', { recording_id: otherRec })).status).toBe(404);
  });

  it('IT activity names file transfers and update installs; no group field can hide the tray', async () => {
    const a = await newAccount('user-act');
    const { epId, cred } = await onlineEndpoint(a, 'ACT-PC');
    for (let i = 0; i < 3; i++) {
      await systemPool.query(
        `INSERT INTO audit_logs (organization_id, user_email, action, target_type, target_id, metadata) VALUES ($1, 'it@example.test', 'endpoint.fs_op', 'endpoint', $2, $3)`,
        [a.organizationId, epId, JSON.stringify({ op: 'upload', path: 'C:\\Users\\Public\\setup.log', offset: i * 1024 })],
      );
    }
    await systemPool.query(
      `INSERT INTO audit_logs (organization_id, user_email, action, target_type, target_id, metadata) VALUES ($1, 'it@example.test', 'fleet.session_file_transfer', 'endpoint', $2, $3)`,
      [a.organizationId, epId, JSON.stringify({ direction: 'from_remote', name: 'report.pdf', size: 10 })],
    );
    await systemPool.query(
      `INSERT INTO fleet_patch_installs (organization_id, endpoint_id, source, state, updates, why, window_label, finished_at)
       VALUES ($1, $2, 'wua', 'succeeded', $3, 'approved', 'Group window', now())`,
      [a.organizationId, epId, JSON.stringify([{ update_id: 'u1', title: 'Cumulative update', kb: 'KB5050001', classification: 'security' }])],
    );
    const res = await request(app).post('/api/v1/agent/it-activity').set('Authorization', `Bearer ${cred}`).send({});
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ kind: string; what: string; by: string; reason: string | null }>;
    const files = items.filter((i) => i.kind === 'file_transfer');
    // Three chunks of one upload are one line; the session transfer is another.
    expect(files.map((f) => f.what).sort()).toEqual(['File copied from this computer: report.pdf', 'File sent to this computer: C:\\Users\\Public\\setup.log']);
    const patch = items.find((i) => i.kind === 'patch');
    expect(patch).toMatchObject({ what: 'Updates: KB5050001', reason: 'Group window' });

    // The tray cannot be switched off by policy: such fields are refused.
    for (const field of ['tray_hidden', 'hide_tray', 'tray_enabled', 'it_activity_enabled']) {
      expect((await a.agent.post('/api/v1/fleet/groups').set(CSRF).send({ name: `G ${field}`, [field]: false })).status).toBe(400);
    }
  });
});
