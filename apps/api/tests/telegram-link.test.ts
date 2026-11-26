import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { dispatchNotifications, newDeviceActions, pollTelegramChannel } from '../src/modules/notifications/index.ts';
import { CSRF, newAccount, type TestAccount } from './helpers.ts';

// Telegram by QR (UX review item 10), against a fake Bot API on this machine (no real network).

interface Call {
  method: string;
  body: Record<string, unknown>;
}

const BOT_TOKEN = '987654321:AAH_fake_bot_token_for_tests_only';
const calls: Call[] = [];
let updates: Record<string, unknown>[] = [];
let failGetUpdates: string | null = null;
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (!m || m[1] !== BOT_TOKEN) return send(401, { ok: false, description: 'Unauthorized' });
      const method = m[2]!;
      calls.push({ method, body });
      if (method === 'getMe') return send(200, { ok: true, result: { id: 987654321, is_bot: true, username: 'nigafiy_home_bot' } });
      if (method === 'getUpdates') {
        if (failGetUpdates) return send(409, { ok: false, description: failGetUpdates });
        const offset = Number(body.offset ?? 0);
        return send(200, { ok: true, result: updates.filter((u) => Number(u.update_id) >= offset) });
      }
      return send(200, { ok: true, result: true });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const callsOf = (method: string) => calls.filter((c) => c.method === method);

async function telegramChannel(a: TestAccount, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await a.agent
    .post('/api/v1/notification-channels')
    .set(CSRF)
    .send({ kind: 'telegram', name: 'Family', bot_token: BOT_TOKEN, api_base: base, min_severity: 'info', ...extra });
  expect(r.status).toBe(201);
  return r.body.channel.id as string;
}

let hostNo = 10;

async function deviceEvent(a: TestAccount, channelId: string): Promise<{ deviceId: string; deliveryId: string }> {
  const ip = `192.168.60.${hostNo++}`;
  const deviceId = (
    await systemPool.query<{ id: string }>(
      `INSERT INTO devices (organization_id, site_id, identity_basis, current_ip, hostname, device_type, type_source, first_seen_at, last_seen_at)
       VALUES ($1,$2,'ip',$3,'new-phone','unknown','manual',now(),now()) RETURNING id`,
      [a.organizationId, a.siteId, ip],
    )
  ).rows[0]!.id;
  const eventId = (
    await systemPool.query<{ id: string }>(
      `INSERT INTO network_events (organization_id, site_id, device_id, type, severity, title, details, source, occurred_at)
       VALUES ($1,$2,$3,'new_device','critical','New device joined',$4,'platform',now()) RETURNING id`,
      [a.organizationId, a.siteId, deviceId, JSON.stringify({ ip, actions: newDeviceActions(deviceId) })],
    )
  ).rows[0]!.id;
  const deliveryId = (
    await systemPool.query<{ id: string }>(`INSERT INTO notification_deliveries (organization_id, channel_id, event_id) VALUES ($1,$2,$3) RETURNING id`, [
      a.organizationId,
      channelId,
      eventId,
    ])
  ).rows[0]!.id;
  return { deviceId, deliveryId };
}

async function deliver(deliveryId: string) {
  for (let i = 0; i < 5; i++) {
    await dispatchNotifications();
    const d = (await systemPool.query<{ status: string; last_error: string | null }>(`SELECT status, last_error FROM notification_deliveries WHERE id = $1`, [deliveryId]))
      .rows[0]!;
    if (d.status !== 'pending' || d.last_error) return d;
  }
  return (await systemPool.query<{ status: string; last_error: string | null }>(`SELECT status, last_error FROM notification_deliveries WHERE id = $1`, [deliveryId])).rows[0]!;
}

describe('Telegram by QR', () => {
  it('links a chat by "/start <code>", sends it buttons, and acts on a press only from a linked chat', async () => {
    const a = await newAccount('tg');
    const channelId = await telegramChannel(a);

    const link = await a.agent.post(`/api/v1/notification-channels/${channelId}/telegram-link`).set(CSRF).send({ language: 'ar' });
    expect(link.status).toBe(201);
    expect(link.body.bot_username).toBe('nigafiy_home_bot');
    const url = new URL(link.body.url as string);
    expect(url.origin + url.pathname).toBe('https://t.me/nigafiy_home_bot');
    const code = url.searchParams.get('start')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    // Only the code's hash is stored.
    const stored = await systemPool.query(`SELECT 1 FROM telegram_link_codes WHERE channel_id = $1 AND code_hash = encode(sha256($2::bytea), 'hex')`, [channelId, code]);
    expect(stored.rowCount).toBe(1);

    updates = [
      { update_id: 500, message: { chat: { id: 555, type: 'private', first_name: 'Mona' }, text: `/start ${code}` } },
      // The same code a second time, from someone else: refused.
      { update_id: 501, message: { chat: { id: 777, type: 'private', first_name: 'Guest' }, text: `/start ${code}` } },
    ];
    calls.length = 0;
    await pollTelegramChannel(channelId);
    const replies = callsOf('sendMessage');
    expect(replies.find((c) => c.body.chat_id === 555)?.body.text).toContain('تم الربط');
    expect(String(replies.find((c) => c.body.chat_id === 777)?.body.text)).toContain('not valid');

    const chats = await a.agent.get(`/api/v1/notification-channels/${channelId}/telegram-chats`);
    expect(chats.status).toBe(200);
    expect(chats.body.items).toHaveLength(1);
    expect(chats.body.items[0]).toMatchObject({ title: 'Mona', chat_type: 'private', language: 'ar' });
    expect(chats.body.polling).toMatchObject({ healthy: true, last_error: null });

    // The next read starts after what was handled.
    calls.length = 0;
    await pollTelegramChannel(channelId);
    expect(callsOf('getUpdates')[0]?.body.offset).toBe(502);
    expect(callsOf('sendMessage')).toHaveLength(0);

    // A notification with buttons: inline buttons, in the chat's language, to the linked chat only.
    const { deviceId, deliveryId } = await deviceEvent(a, channelId);
    calls.length = 0;
    expect((await deliver(deliveryId)).status).toBe('delivered');
    const sent = callsOf('sendMessage').filter((c) => c.body.chat_id === '555');
    expect(sent).toHaveLength(1);
    const keyboard = (sent[0]!.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]!;
    expect(keyboard.map((b) => b.text)).toEqual(['السماح', 'إيقاف مؤقت']);
    const allowData = keyboard[0]!.callback_data;

    // Pressed from a chat that is not linked: nothing happens.
    updates = [{ update_id: 502, callback_query: { id: 'cq1', data: allowData, message: { message_id: 9, chat: { id: 777, type: 'private' } } } }];
    calls.length = 0;
    await pollTelegramChannel(channelId);
    expect(String(callsOf('answerCallbackQuery')[0]?.body.text)).toContain('not linked');
    expect((await systemPool.query<{ trust: string }>(`SELECT trust FROM devices WHERE id = $1`, [deviceId])).rows[0]!.trust).not.toBe('known');

    // Pressed in the linked chat: the device is allowed, the buttons are removed.
    updates = [{ update_id: 503, callback_query: { id: 'cq2', data: allowData, message: { message_id: 9, chat: { id: 555, type: 'private' } } } }];
    calls.length = 0;
    await pollTelegramChannel(channelId);
    expect(String(callsOf('answerCallbackQuery')[0]?.body.text)).toContain('تم السماح');
    expect(callsOf('editMessageReplyMarkup')[0]?.body).toMatchObject({ chat_id: 555, message_id: 9 });
    expect((await systemPool.query<{ trust: string }>(`SELECT trust FROM devices WHERE id = $1`, [deviceId])).rows[0]!.trust).toBe('known');
    const audited = (
      await systemPool.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'device.updated' AND target_id = $2`, [
        a.organizationId,
        deviceId,
      ])
    ).rows[0]!;
    expect(audited.metadata).toMatchObject({ via: 'notification_action', telegram_chat_id: '555', channel_id: channelId });

    // Pressed again: already used.
    updates = [{ update_id: 504, callback_query: { id: 'cq3', data: allowData, message: { message_id: 9, chat: { id: 555, type: 'private' } } } }];
    calls.length = 0;
    await pollTelegramChannel(channelId);
    expect(String(callsOf('answerCallbackQuery')[0]?.body.text)).toContain('استُخدم');

    // Unlinking the only chat: deliveries say what to do.
    const del = await a.agent.delete(`/api/v1/notification-channels/${channelId}/telegram-chats/${chats.body.items[0].id}`).set(CSRF);
    expect(del.status).toBe(204);
    const second = await deviceEvent(a, channelId);
    expect((await deliver(second.deliveryId)).last_error).toContain('scan the QR code');
  });

  it('keeps a typed chat ID working, and falls back to links when the update stream cannot be read', async () => {
    const a = await newAccount('tgl');
    const channelId = await telegramChannel(a, { chat_id: '-100424242', message_thread_id: 3 });

    failGetUpdates = 'Conflict: can\'t use getUpdates method while webhook is active';
    try {
      await pollTelegramChannel(channelId);
    } finally {
      failGetUpdates = null;
    }
    const chats = await a.agent.get(`/api/v1/notification-channels/${channelId}/telegram-chats`);
    expect(chats.body).toMatchObject({ legacy_chat_id: '-100424242', polling: { healthy: false } });
    expect(chats.body.polling.last_error).toContain('webhook');
    expect(chats.body.polling.last_error).not.toContain(BOT_TOKEN);

    const { deliveryId } = await deviceEvent(a, channelId);
    calls.length = 0;
    expect((await deliver(deliveryId)).status).toBe('delivered');
    const sent = callsOf('sendMessage').find((c) => c.body.chat_id === '-100424242')!;
    expect(sent.body.message_thread_id).toBe(3);
    expect(sent.body.reply_markup).toBeUndefined();
    expect(String(sent.body.text)).toContain('/notification-action/');

    // A press from the typed chat is accepted once polling works.
    await pollTelegramChannel(channelId);
    const { deviceId, deliveryId: d2 } = await deviceEvent(a, channelId);
    calls.length = 0;
    await deliver(d2);
    const keyboard = (callsOf('sendMessage')[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]!;
    updates = [{ update_id: 900, callback_query: { id: 'cqL', data: keyboard[1]!.callback_data, message: { message_id: 4, chat: { id: -100424242, type: 'supergroup' } } } }];
    await pollTelegramChannel(channelId);
    const paused = (await systemPool.query<{ internet_paused_until: Date | null }>(`SELECT internet_paused_until FROM devices WHERE id = $1`, [deviceId])).rows[0]!;
    expect(paused.internet_paused_until).not.toBeNull();
  });

  it('refuses a QR link for a channel that is not Telegram, and a bot token Telegram rejects', async () => {
    const a = await newAccount('tgx');
    const hook = await a.agent.post('/api/v1/notification-channels').set(CSRF).send({ kind: 'webhook', name: 'h', url: 'https://example.test/h' });
    const r = await a.agent.post(`/api/v1/notification-channels/${hook.body.channel.id}/telegram-link`).set(CSRF).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('not_telegram_channel');

    const bad = await a.agent
      .post('/api/v1/notification-channels')
      .set(CSRF)
      .send({ kind: 'telegram', name: 'Bad', bot_token: '111111111:AAH_wrong_token_xxxxxxxx', api_base: base });
    const r2 = await a.agent.post(`/api/v1/notification-channels/${bad.body.channel.id}/telegram-link`).set(CSRF).send({});
    expect(r2.status).toBe(502);
    expect(r2.body.error.code).toBe('telegram_bot_rejected');
  });
});
