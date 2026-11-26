import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import type { NotificationAction } from '@nigafiy/shared-types/notification-actions';
import { importJWK, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import {
  buildPushMessage,
  deliverPush,
  encryptPushPayload,
  type PushRequest,
  pushTransport,
  validPushEndpoint,
  vapidKeys,
} from '../src/modules/notifications/webpush.ts';
import { CSRF, newAccount } from './helpers.ts';

/** UX review item 11: Web Push (RFC 8291 encryption, RFC 8292 VAPID) with no real network. */

const realSend = pushTransport.send;
afterEach(() => {
  pushTransport.send = realSend;
});

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** A browser: its P-256 key pair and auth secret. */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
}

/** What the browser does with a push body (RFC 8291 §3, RFC 8188 single record). */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, authB64: string): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const secret = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, Buffer.from(authB64, 'base64url'), keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(0x02);
  return plain.subarray(0, end).toString('utf8');
}

describe('RFC 8291 message encryption', () => {
  it('matches the example in RFC 8291 Appendix A', () => {
    const body = encryptPushPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      { privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'), publicKey: Buffer.alloc(0) },
    );
    expect(b64u(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('round-trips with a fresh browser key and refuses a too-large message', () => {
    const b = browserKeys();
    const text = JSON.stringify({ title: 'جهاز جديد انضم', body: 'x'.repeat(500) });
    expect(decrypt(encryptPushPayload(Buffer.from(text), b.keys), b.ecdh, b.keys.auth)).toBe(text);
    expect(() => encryptPushPayload(Buffer.alloc(4090), b.keys)).toThrow(/too large/);
  });
});

describe('push endpoints', () => {
  it('accepts only HTTPS addresses of the known push services', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
      'https://web.push.apple.com/QGx',
    ]) {
      expect(validPushEndpoint(ok), ok).not.toBeNull();
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://localhost/push',
      'https://127.0.0.1/push',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilpush.services.mozilla.com.example/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'not a url',
    ]) {
      expect(validPushEndpoint(bad), bad).toBeNull();
    }
  });
});

describe('the push message', () => {
  const actions: NotificationAction[] = [
    { kind: 'open', label: { en: 'Open', ar: 'فتح' }, path: '/radar/devices/x' },
    { kind: 'allow_device', label: { en: 'Allow', ar: 'السماح' }, token: 't-allow' },
    { kind: 'pause_device', label: { en: 'Pause', ar: 'إيقاف مؤقت' }, token: 't-pause' },
  ];
  const event = {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'new_device',
    severity: 'warning',
    title: 'New device joined: phone',
    details: { ip: '192.168.1.20', vendor: 'Acme', actions: [{ kind: 'allow_device' }] },
    occurred_at: new Date().toISOString(),
    site_name: 'Home',
    device_id: '00000000-0000-4000-8000-0000000000aa',
    actions,
  };

  it('puts the buttons that act first, at most two, in the subscription language', () => {
    const ar = buildPushMessage(event, 'My home', 'ar');
    expect(ar.actions.map((a) => a.title)).toEqual(['السماح', 'إيقاف مؤقت']);
    expect(ar.actions.map((a) => a.token)).toEqual(['t-allow', 't-pause']);
    expect(ar.url).toBe('/radar/devices/00000000-0000-4000-8000-0000000000aa');
    expect(ar.body).toContain('My home / Home');
    expect(ar.body).not.toContain('actions');
    expect(ar.done.pause_device).toMatch(/الإيقاف/);
    expect(buildPushMessage({ ...event, actions: [] }, 'x', 'en').actions).toEqual([]);
  });
});

describe('subscriptions and delivery', () => {
  const endpoint = () => `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('base64url')}`;

  it('creates one push channel, stores the subscription sealed, and keeps tenants apart', async () => {
    const acct = await newAccount('push');
    const first = await acct.agent.get('/api/v1/notifications/push');
    expect(first.status).toBe(200);
    expect(first.body.public_key).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(first.body.channel).toBeNull();

    const b = browserKeys();
    const url = endpoint();
    const sub = await acct.agent.post('/api/v1/notifications/push/subscriptions').set(CSRF).send({ endpoint: url, keys: b.keys, language: 'ar' });
    expect(sub.status).toBe(201);
    const again = await acct.agent.post('/api/v1/notifications/push/subscriptions').set(CSRF).send({ endpoint: url, keys: b.keys, language: 'en' });
    expect(again.status).toBe(200);
    expect(again.body.channel_id).toBe(sub.body.channel_id);
    const second = await acct.agent.post('/api/v1/notifications/push/subscriptions').set(CSRF).send({ endpoint: endpoint(), keys: browserKeys().keys });
    expect(second.status).toBe(201);
    expect(second.body.channel_id).toBe(sub.body.channel_id);

    const stored = await systemPool.query<{ subscription_sealed: string; language: string; endpoint_host: string }>(
      `SELECT subscription_sealed, language, endpoint_host FROM webpush_subscriptions WHERE organization_id = $1 ORDER BY created_at`,
      [acct.organizationId],
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0]!.language).toBe('en');
    expect(stored.rows[0]!.endpoint_host).toBe('fcm.googleapis.com');
    expect(stored.rows[0]!.subscription_sealed).not.toContain('fcm.googleapis.com');
    expect(stored.rows[0]!.subscription_sealed).not.toContain(b.keys.auth);

    const channels = await acct.agent.get('/api/v1/notification-channels');
    expect(channels.body.items.filter((c: { kind: string }) => c.kind === 'push')).toHaveLength(1);

    const listed = await acct.agent.get('/api/v1/notifications/push');
    expect(listed.body.subscriptions).toHaveLength(2);
    expect(listed.body.subscriptions[0].user_email).toBe(acct.email);
    expect(JSON.stringify(listed.body)).not.toContain(url);

    const other = await newAccount('push-other');
    expect((await other.agent.get('/api/v1/notifications/push')).body.subscriptions).toEqual([]);
    expect((await other.agent.delete(`/api/v1/notifications/push/subscriptions/${sub.body.id}`).set(CSRF)).status).toBe(404);

    const off = await acct.agent.post('/api/v1/notifications/push/unsubscribe').set(CSRF).send({ endpoint: url });
    expect(off.body.removed).toBe(1);
    const audit = await systemPool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'notification.push.%'`, [acct.organizationId]);
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['notification.push.subscribed', 'notification.push.subscribed', 'notification.push.subscribed', 'notification.push.unsubscribed']);
  });

  it('refuses addresses outside the push services and unusable keys', async () => {
    const acct = await newAccount('push-bad');
    const keys = browserKeys().keys;
    const bad = await acct.agent.post('/api/v1/notifications/push/subscriptions').set(CSRF).send({ endpoint: 'https://192.168.1.1/hook', keys });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('push_endpoint_invalid');
    const badKeys = await acct.agent
      .post('/api/v1/notifications/push/subscriptions')
      .set(CSRF)
      .send({ endpoint: endpoint(), keys: { p256dh: b64u(Buffer.alloc(65, 4)), auth: keys.auth } });
    expect(badKeys.status).toBe(400);
    expect(badKeys.body.error.code).toBe('push_keys_invalid');
  });

  it('delivers an encrypted, VAPID-signed message and removes a subscription the service reports gone', async () => {
    const acct = await newAccount('push-send');
    const live = browserKeys();
    const liveUrl = endpoint();
    const goneUrl = endpoint();
    const s1 = await acct.agent.post('/api/v1/notifications/push/subscriptions').set(CSRF).send({ endpoint: liveUrl, keys: live.keys, language: 'ar' });
    await acct.agent.post('/api/v1/notifications/push/subscriptions').set(CSRF).send({ endpoint: goneUrl, keys: browserKeys().keys });

    const test = await acct.agent.post(`/api/v1/notification-channels/${s1.body.channel_id}/test`).set(CSRF);
    expect(test.status).toBeLessThan(300);
    const delivery = (
      await systemPool.query<{ id: string }>(`SELECT id FROM notification_deliveries WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 1`, [s1.body.channel_id])
    ).rows[0]!;

    const sent: PushRequest[] = [];
    pushTransport.send = async (req) => {
      sent.push(req);
      return req.endpoint.href === goneUrl ? 410 : 201;
    };
    const event = {
      id: '00000000-0000-4000-8000-000000000002',
      type: 'notification_test',
      severity: 'critical',
      title: 'Test notification from Nigafiy',
      details: { test: true },
      occurred_at: new Date().toISOString(),
    };
    expect(await deliverPush(delivery.id, event, 'Acme')).toBeNull();
    expect(sent).toHaveLength(2);

    const req = sent.find((r) => r.endpoint.href === liveUrl)!;
    expect(req.headers['Content-Encoding']).toBe('aes128gcm');
    expect(req.headers.Urgency).toBe('high');
    const msg = JSON.parse(decrypt(req.body, live.ecdh, live.keys.auth));
    expect(msg).toMatchObject({ title: 'Test notification from Nigafiy', lang: 'ar', severity: 'critical' });

    // VAPID: signed by this installation's key, for the push service's origin.
    const vapid = await vapidKeys();
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.Authorization!)!;
    expect(m[2]).toBe(vapid.publicKey);
    const pub = await importJWK({ kty: 'EC', crv: 'P-256', x: vapid.privateJwk.x, y: vapid.privateJwk.y }, 'ES256');
    const { payload } = await jwtVerify(m[1]!, pub, { audience: 'https://fcm.googleapis.com' });
    expect(payload.exp! - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600);

    const left = await systemPool.query<{ last_success_at: Date | null }>(`SELECT last_success_at FROM webpush_subscriptions WHERE organization_id = $1`, [acct.organizationId]);
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0]!.last_success_at).not.toBeNull();

    // Every browser failing: the reason comes back so the dispatcher retries.
    pushTransport.send = async () => 500;
    expect(await deliverPush(delivery.id, event, 'Acme')).toMatch(/HTTP 500/);
  });

  it('says why when nobody has push turned on', async () => {
    const acct = await newAccount('push-none');
    const s = await acct.agent.post('/api/v1/notifications/push/subscriptions').set(CSRF).send({ endpoint: endpoint(), keys: browserKeys().keys });
    await acct.agent.delete(`/api/v1/notifications/push/subscriptions/${s.body.id}`).set(CSRF);
    await acct.agent.post(`/api/v1/notification-channels/${s.body.channel_id}/test`).set(CSRF);
    const delivery = (await systemPool.query<{ id: string }>(`SELECT id FROM notification_deliveries WHERE channel_id = $1 LIMIT 1`, [s.body.channel_id])).rows[0]!;
    const ev = { id: 'x', type: 't', severity: 'info', title: 'x', details: {}, occurred_at: new Date().toISOString() };
    expect(await deliverPush(delivery.id, ev, 'x')).toMatch(/no phone or browser/);
  });
});
