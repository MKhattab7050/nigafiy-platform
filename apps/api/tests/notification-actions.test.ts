import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool, withSystem } from '../src/infrastructure/db.ts';
import {
  issueActionTokens,
  newDeviceActions,
  redeemActionToken,
  renderEmail,
  renderNtfyMessage,
  renderSlackPayload,
  renderTelegramPayload,
} from '../src/modules/notifications/index.ts';
import { app, CSRF, newAccount, type TestAccount } from './helpers.ts';

// Buttons on notifications (UX review item 9): single-use, expiring tokens that act without a session.

async function addDevice(a: TestAccount, name = 'kids-tablet'): Promise<string> {
  const r = await systemPool.query<{ id: string }>(
    `INSERT INTO devices (organization_id, site_id, identity_basis, current_ip, hostname, device_type, type_source, first_seen_at, last_seen_at)
     VALUES ($1,$2,'ip','192.168.50.23',$3,'unknown','manual',now(),now()) RETURNING id`,
    [a.organizationId, a.siteId, name],
  );
  return r.rows[0]!.id;
}

async function tokensFor(a: TestAccount, deviceId: string, now = new Date(), channelId: string | null = null) {
  const issued = await withSystem((db) => issueActionTokens(db, a.organizationId, deviceId, newDeviceActions(deviceId), { channelId }, now));
  const tok = (kind: string) => issued.find((x) => x.kind === kind)!.token!;
  return { issued, allow: tok('allow_device'), pause: tok('pause_device') };
}

const device = async (id: string) =>
  (await systemPool.query<{ trust: string; internet_paused_until: Date | null }>(`SELECT trust, internet_paused_until FROM devices WHERE id = $1`, [id])).rows[0]!;

describe('notification buttons', () => {
  it('GET only describes a button; POST allows the device once and audits it as the owner', async () => {
    const a = await newAccount('btn');
    const id = await addDevice(a);
    const { allow, issued } = await tokensFor(a, id);
    expect(issued.find((x) => x.kind === 'open')?.token).toBeUndefined();

    const before = await device(id);
    const info = await request(app).get(`/api/v1/notification-actions/${allow}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ kind: 'allow_device', used: false, expired: false, device: { id, label: 'kids-tablet' } });
    expect(info.headers['cache-control']).toBe('no-store');
    // Fetching twice (a link scanner, a mail preview) changes nothing.
    await request(app).get(`/api/v1/notification-actions/${allow}`);
    expect((await device(id)).trust).toBe(before.trust);
    const unused = await systemPool.query(`SELECT used_at FROM notification_action_tokens WHERE organization_id = $1 AND kind = 'allow_device'`, [a.organizationId]);
    expect(unused.rows[0].used_at).toBeNull();

    const done = await request(app).post(`/api/v1/notification-actions/${allow}`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ kind: 'allow_device', trust: 'known', device: { id } });
    expect((await device(id)).trust).toBe('known');

    const auditRow = (
      await systemPool.query<{ user_email: string; metadata: Record<string, unknown> }>(
        `SELECT user_email, metadata FROM audit_logs WHERE organization_id = $1 AND action = 'device.updated' AND target_id = $2`,
        [a.organizationId, id],
      )
    ).rows[0]!;
    expect(auditRow.user_email).toBe(a.email);
    expect(auditRow.metadata).toMatchObject({ via: 'notification_action', kind: 'allow_device', trust: 'known' });

    const again = await request(app).post(`/api/v1/notification-actions/${allow}`);
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('action_used');
    expect((await request(app).get(`/api/v1/notification-actions/${allow}`)).body.used).toBe(true);
  });

  it('pause sets the device internet pause for 7 days through the normal path', async () => {
    const a = await newAccount('btnp');
    const id = await addDevice(a);
    const { pause } = await tokensFor(a, id);
    const r = await request(app).post(`/api/v1/notification-actions/${pause}`);
    expect(r.status).toBe(200);
    const until = (await device(id)).internet_paused_until!;
    const days = (until.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const audited = await systemPool.query(`SELECT 1 FROM audit_logs WHERE organization_id = $1 AND action = 'device.internet.pause' AND target_id = $2`, [a.organizationId, id]);
    expect(audited.rowCount).toBe(1);
  });

  it('refuses expired, unknown and malformed tokens, and a token pressed in another channel', async () => {
    const a = await newAccount('btnx');
    const id = await addDevice(a);
    const old = await tokensFor(a, id, new Date(Date.now() - 25 * 3600_000));
    const expired = await request(app).post(`/api/v1/notification-actions/${old.allow}`);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('action_expired');
    expect((await request(app).get(`/api/v1/notification-actions/${old.allow}`)).body.expired).toBe(true);
    expect((await device(id)).trust).not.toBe('known');

    expect((await request(app).post(`/api/v1/notification-actions/${'A'.repeat(43)}`)).status).toBe(404);
    expect((await request(app).post('/api/v1/notification-actions/short')).status).toBe(404);
    expect((await request(app).get(`/api/v1/notification-actions/${'x'.repeat(200)}`)).status).toBe(400);

    // Bound to one channel: the same token pressed through a different channel's bot is not valid.
    const ch = await a.agent
      .post('/api/v1/notification-channels')
      .set(CSRF)
      .send({ kind: 'webhook', name: 'hook', url: 'https://example.test/hook' });
    expect(ch.status).toBe(201);
    const fresh = await tokensFor(a, id, new Date(), ch.body.channel.id);
    await expect(redeemActionToken(fresh.allow, null, new Date(), { channelId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ status: 404 });
    await expect(redeemActionToken(fresh.allow, null, new Date(), { channelId: ch.body.channel.id })).resolves.toMatchObject({ kind: 'allow_device' });
  });

  it('channels show the buttons, and never print them as a detail', () => {
    const actions = [
      { kind: 'allow_device' as const, label: { en: 'Allow', ar: 'السماح' }, token: 'tokAllow_0123456789abcdefghijklmnopqrstuvwxy' },
      { kind: 'pause_device' as const, label: { en: 'Pause', ar: 'إيقاف مؤقت' }, token: 'tokPause_0123456789abcdefghijklmnopqrstuvwxy' },
      { kind: 'open' as const, label: { en: 'Open', ar: 'فتح' }, path: '/radar/devices/x' },
    ];
    const ev = {
      id: '1',
      type: 'new_device',
      severity: 'warning',
      title: 'New device joined',
      details: { ip: '192.168.50.23', actions: actions.map(({ token: _t, ...rest }) => rest) },
      occurred_at: '2026-11-26T00:00:00Z',
      device_id: '6f0c6c55-6a59-4a4e-9d0f-2f0f5d0f9b11',
      actions,
    };
    const base = 'https://nms.example';

    const tgLinks = renderTelegramPayload(ev, 'Home', '42', undefined, base);
    expect(tgLinks.reply_markup).toBeUndefined();
    expect(String(tgLinks.text)).toContain(`${base}/notification-action/${actions[0]!.token}`);
    expect(String(tgLinks.text)).not.toContain('actions:');

    const tgButtons = renderTelegramPayload(ev, 'Home', '42', undefined, base, { callbacks: true, language: 'ar' });
    const keyboard = (tgButtons.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]!;
    expect(keyboard.map((b) => b.text)).toEqual(['السماح', 'إيقاف مؤقت']);
    expect(keyboard[0]!.callback_data).toBe(`na:${actions[0]!.token}`);
    for (const b of keyboard) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    expect(String(tgButtons.text)).not.toContain('/notification-action/');

    const ntfy = renderNtfyMessage(ev, 'Home', base);
    expect(ntfy.headers['X-Actions']).toBe(
      `http, Allow, ${base}/api/v1/notification-actions/${actions[0]!.token}, method=POST, clear=true; http, Pause, ${base}/api/v1/notification-actions/${actions[1]!.token}, method=POST, clear=true`,
    );
    expect(ntfy.body).not.toContain('actions:');

    const slack = JSON.stringify(renderSlackPayload(ev, 'Home', base));
    expect(slack).toContain(`${base}/notification-action/${actions[1]!.token}`);

    const mail = renderEmail(ev, 'Home');
    expect(mail.text).toContain(`/notification-action/${actions[0]!.token}`);
    expect(mail.text).toContain('Allow / السماح');
    expect(mail.text).not.toContain('actions:');
  });
});
