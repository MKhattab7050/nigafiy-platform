import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool, withSystem } from '../src/infrastructure/db.ts';
import { emitEvent } from '../src/modules/events/index.ts';
import { dispatchNotifications } from '../src/modules/notifications/index.ts';
import { CSRF, app, newAccount, type TestAccount } from './helpers.ts';

// Network alerts on admin phones (migration 067, docs/roadmap/2026-11-26-admin-phones.md).

async function phone(a: TestAccount, role: 'user' | 'admin', name: string) {
  const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name, platform: 'android', phone_role: role });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const enrolled = await request(app)
    .post('/api/v1/agent/enroll')
    .send({ enrollment_token: created.body.enrollment_token, agent_version: '1.0.6', hostname: name, platform: 'android', os: 'android', os_version: 'Android 16 (API 36)', arch: 'arm64-v8a' });
  expect(enrolled.status).toBe(201);
  return { epId: created.body.endpoint.id as string, cred: enrolled.body.credential as string };
}

const beat = async (cred: string) => {
  const r = await request(app)
    .post('/api/v1/agent/heartbeat')
    .set('Authorization', `Bearer ${cred}`)
    .send({ agent_version: '1.0.6', hostname: 'P', platform: 'android', os: 'android', os_version: 'Android 16 (API 36)', arch: 'arm64-v8a', uptime_seconds: 100, ram_used_mb: 1, ram_pct: 1 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { phone_role?: string; alerts?: { title: string; severity: string; resolved: boolean; path: string }[] };
};

async function addDevice(a: TestAccount, ip: string): Promise<string> {
  const r = await systemPool.query<{ id: string }>(
    `INSERT INTO devices (organization_id, site_id, identity_basis, current_ip, hostname, device_type, type_source, first_seen_at, last_seen_at)
     VALUES ($1,$2,'ip',$3,$4,'unknown','manual',now(),now()) RETURNING id`,
    [a.organizationId, a.siteId, ip, `host-${ip}`],
  );
  return r.rows[0]!.id;
}

const emit = (a: TestAccount, deviceId: string | null, type: string, severity: 'info' | 'warning' | 'critical', title: string) =>
  withSystem((db) => emitEvent(db, a.organizationId, { siteId: a.siteId, deviceId, type, severity, title, details: {}, source: 'platform', occurredAt: new Date() }));

describe('alerts on admin phones', () => {
  it('important problems reach every admin phone once; regular phones get none; resolved only for a problem they saw', async () => {
    const a = await newAccount('phone-alerts');
    const admin = await phone(a, 'admin', 'Owner phone');
    const user = await phone(a, 'user', 'Kid phone');
    const nas = await addDevice(a, '10.30.0.5');
    const other = await addDevice(a, '10.30.0.6');

    await emit(a, nas, 'device_offline', 'warning', 'NAS went offline');
    await emit(a, other, 'device_new', 'info', 'A new device joined');
    await dispatchNotifications();

    const first = await beat(admin.cred);
    expect(first.phone_role).toBe('admin');
    expect(first.alerts?.map((x) => [x.title, x.severity, x.resolved])).toEqual([['NAS went offline', 'warning', false]]);
    expect(first.alerts?.[0]?.path).toBe(`/radar/devices/${nas}`);
    expect((await beat(admin.cred)).alerts).toEqual([]);
    expect((await beat(user.cred)).alerts).toBeUndefined();

    // Back online: the phone saw it go down, so it hears it came back. Another device coming online is not news.
    await emit(a, nas, 'device_online', 'info', 'NAS is back online');
    await emit(a, other, 'device_online', 'info', 'Some phone is online');
    await dispatchNotifications();
    expect((await beat(admin.cred)).alerts?.map((x) => [x.title, x.resolved])).toEqual([['NAS is back online', true]]);
  });

  it('the Admin phones channel is made once, with the important-only filter', async () => {
    const a = await newAccount('phone-alerts-channel');
    await phone(a, 'admin', 'One');
    const second = await phone(a, 'user', 'Two');
    await a.agent.post(`/api/v1/endpoints/${second.epId}/phone-role`).set(CSRF).send({ role: 'admin' });
    const ch = await systemPool.query(`SELECT min_severity, event_types FROM notification_channels WHERE organization_id = $1 AND kind = 'phone'`, [a.organizationId]);
    expect(ch.rows).toHaveLength(1);
    expect(ch.rows[0].min_severity).toBe('warning');
    expect(ch.rows[0].event_types).toContain('device_online');
  });

  it("the channel's Test button reaches the admin phone", async () => {
    const a = await newAccount('phone-alerts-test');
    const admin = await phone(a, 'admin', 'Owner phone');
    const ch = await systemPool.query<{ id: string }>(`SELECT id FROM notification_channels WHERE organization_id = $1 AND kind = 'phone'`, [a.organizationId]);
    const sent = await a.agent.post(`/api/v1/notification-channels/${ch.rows[0]!.id}/test`).set(CSRF).send({});
    expect(sent.status).toBe(202);
    await dispatchNotifications();
    expect((await beat(admin.cred)).alerts?.map((x) => [x.title, x.resolved])).toEqual([['Test notification from Nigafiy', false]]);
  });
});
