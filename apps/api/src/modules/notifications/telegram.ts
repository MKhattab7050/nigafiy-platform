import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { decryptSecret, randomToken, sha256 } from '../../common/crypto.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { isPublicAddress } from '../../common/net.ts';
import { env } from '../../config/env.ts';
import { withSystem, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { redeemActionToken } from './action-tokens.ts';
import { TELEGRAM_CALLBACK_PREFIX, renderTelegramPayload } from './channels.ts';
import type { NotificationEvent } from './email.ts';

// Telegram by QR (UX review 2026-11-26, item 10; migration 057).
//
// The owner makes a bot with @BotFather and pastes its token (there is no central Nigafiy server to
// host one shared bot). Settings then shows a QR code for https://t.me/<bot>?start=<one-time code>:
// scanning it opens the bot, pressing Start sends "/start <code>", and the polling job below binds that
// chat to the channel. No chat ID to look up. Several chats can be bound (family members, a group);
// messages go to all of them, and a pressed button (callback query) is accepted only from them.
//
// The API reads the bot's update stream with getUpdates (short polls). That works on a home PC behind
// NAT where a webhook could not reach it. If something else reads the same bot (another program, or a
// webhook set on it), Telegram refuses getUpdates; the error is shown in Settings and buttons fall
// back to links to the confirmation page.

export const LINK_CODE_MINUTES = 15;
/** Buttons are sent as inline buttons only while the update stream was read recently and without error. */
const POLL_HEALTHY_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 1_000_000;

type Lang = 'en' | 'ar';

interface TelegramConfig {
  chat_id?: string;
  message_thread_id?: number;
  api_base?: string;
  bot_username?: string;
}

const apiBase = (config: TelegramConfig): string => (config.api_base || 'https://api.telegram.org').replace(/\/+$/, '');

export interface TelegramReply {
  status: number;
  ok: boolean;
  result?: unknown;
  description?: string;
}

/**
 * One Bot API call, with the same SSRF rules as the other outbound notifications (resolve once,
 * refuse private addresses unless ALLOW_PRIVATE_WEBHOOKS, connect to exactly that address, no
 * redirects, short timeout). Unlike them it reads the JSON answer (getMe, getUpdates).
 */
export async function telegramCall(config: TelegramConfig, botToken: string, method: string, body: Record<string, unknown>): Promise<TelegramReply> {
  const url = new URL(`${apiBase(config)}/bot${botToken}/${method}`);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  const target = addresses[0];
  if (!target) throw new Error('host did not resolve');
  if (!env.ALLOW_PRIVATE_WEBHOOKS && addresses.some((a) => !isPublicAddress(a.address))) {
    throw new Error('destination resolves to a non-public address');
  }
  const pinned = (_host: string, options: { all?: boolean }, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) =>
    options.all ? cb(null, [target]) : cb(null, target.address, target.family);
  const payload = JSON.stringify(body);
  return new Promise<TelegramReply>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), 'User-Agent': 'Nigafiy-Notifications/1' },
        timeout: TIMEOUT_MS,
        lookup: pinned as never,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          let parsed: { ok?: boolean; result?: unknown; description?: string } = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof parsed;
          } catch {
            /* not JSON: judged by the status alone */
          }
          resolve({
            status,
            ok: status >= 200 && status < 300 && parsed.ok !== false,
            result: parsed.result,
            description: typeof parsed.description === 'string' ? parsed.description.slice(0, 200) : undefined,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

const redact = (text: string, botToken: string): string => (botToken ? text.replaceAll(botToken, '[redacted]') : text);

interface BoundChat {
  chat_id: string;
  language: Lang;
  /** The typed chat of a channel made before QR linking (config.chat_id): keeps its message thread. */
  legacy: boolean;
}

async function chatsOf(channelId: string, config: TelegramConfig): Promise<BoundChat[]> {
  const rows = await withSystem(
    async (db) =>
      (await db.query<{ chat_id: string; language: Lang }>(`SELECT chat_id::text, language FROM telegram_chats WHERE channel_id = $1 ORDER BY linked_at`, [channelId]))
        .rows,
  );
  const chats: BoundChat[] = rows.map((r) => ({ chat_id: r.chat_id, language: r.language, legacy: false }));
  if (config.chat_id && !chats.some((c) => c.chat_id === config.chat_id)) chats.unshift({ chat_id: config.chat_id, language: 'en', legacy: true });
  return chats;
}

async function pollingHealthy(channelId: string, now = Date.now()): Promise<boolean> {
  const row = await withSystem(
    async (db) =>
      (await db.query<{ last_poll_at: Date | null; last_error: string | null }>(`SELECT last_poll_at, last_error FROM telegram_poll_state WHERE channel_id = $1`, [channelId]))
        .rows[0],
  );
  return !!row?.last_poll_at && !row.last_error && now - row.last_poll_at.getTime() < POLL_HEALTHY_MS;
}

/**
 * Send one notification delivery to every chat bound to the channel. Returns null when at least one
 * chat received it (a chat that left is logged, not retried, so the others do not get it twice),
 * else the error to record on the delivery.
 */
export async function sendTelegramDelivery(
  deliveryId: string,
  organizationName: string,
  config: TelegramConfig,
  botToken: string,
  event: NotificationEvent,
): Promise<string | null> {
  const channelId = (
    await withSystem(async (db) => (await db.query<{ channel_id: string }>(`SELECT channel_id FROM notification_deliveries WHERE id = $1`, [deliveryId])).rows[0])
  )?.channel_id;
  if (!channelId) return 'delivery not found';
  const chats = await chatsOf(channelId, config);
  if (!chats.length) return 'No Telegram chat is linked yet. Open Settings → Notifications and scan the QR code.';
  const callbacks = await pollingHealthy(channelId);
  const errors: string[] = [];
  let delivered = 0;
  for (const chat of chats) {
    const payload = renderTelegramPayload(event, organizationName, chat.chat_id, chat.legacy ? config.message_thread_id : undefined, undefined, {
      callbacks,
      language: chat.language,
    });
    try {
      const r = await telegramCall(config, botToken, 'sendMessage', payload);
      if (r.ok) delivered++;
      else errors.push(`Telegram responded with HTTP ${r.status}${r.description ? `: ${r.description}` : ''}`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (delivered && errors.length) logger.warn({ delivery_id: deliveryId, failed: errors.length, delivered }, 'some Telegram chats did not receive the notification');
  return delivered ? null : redact(errors[0] ?? 'Telegram did not accept the message', botToken).slice(0, 200);
}

// ── The update stream: "/start <code>" binds a chat, button presses act ──

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}
interface TgUpdate {
  update_id: number;
  message?: { chat: TgChat; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: TgChat } };
}

const TEXT = {
  linked: {
    en: (name: string) => `✅ Linked. Nigafiy notifications from “${name}” will come to this chat.`,
    ar: (name: string) => `✅ تم الربط. ستصل إشعارات Nigafiy من «${name}» إلى هذه المحادثة.`,
  },
  badCode: {
    en: 'This link is not valid or has expired. In Nigafiy open Settings → Notifications and scan a new QR code.',
    ar: 'هذا الرابط غير صالح أو انتهت مدته. افتح في Nigafiy الإعدادات ← الإشعارات وامسح رمز QR جديدًا.',
  },
  notLinked: { en: 'This chat is not linked to Nigafiy.', ar: 'هذه المحادثة غير مربوطة بـ Nigafiy.' },
  allowed: { en: (d: string) => `Allowed: ${d}`, ar: (d: string) => `تم السماح: ${d}` },
  paused: { en: (d: string) => `Internet paused for 7 days: ${d}`, ar: (d: string) => `أُوقف الإنترنت 7 أيام: ${d}` },
  used: { en: 'This button was already used.', ar: 'استُخدم هذا الزر من قبل.' },
  expired: { en: 'This button has expired (after 24 hours). Open Nigafiy to change the device.', ar: 'انتهت صلاحية هذا الزر (بعد 24 ساعة). افتح Nigafiy لتغيير الجهاز.' },
  failed: { en: 'That did not work. Open Nigafiy and try there.', ar: 'تعذّر ذلك. افتح Nigafiy وحاول من هناك.' },
};

const chatTitle = (c: TgChat): string =>
  (c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? `@${c.username}` : '') || String(c.id)).replace(/[\r\n\t]+/g, ' ').slice(0, 80);

interface PolledChannel {
  id: string;
  organization_id: string;
  name: string;
  config: TelegramConfig;
  secret_encrypted: string;
}

async function bindChat(ch: PolledChannel, botToken: string, chat: TgChat, code: string): Promise<void> {
  const linked = await withTenant(ch.organization_id, async (db) => {
    const claimed = (
      await db.query<{ id: string; language: Lang }>(
        `UPDATE telegram_link_codes SET used_at = now()
          WHERE code_hash = $1 AND channel_id = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING id, language`,
        [sha256(code), ch.id],
      )
    ).rows[0];
    if (!claimed) return null;
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO telegram_chats (organization_id, channel_id, chat_id, chat_type, title, language)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (channel_id, chat_id) DO UPDATE SET title = EXCLUDED.title, language = EXCLUDED.language, chat_type = EXCLUDED.chat_type
         RETURNING id`,
        [ch.organization_id, ch.id, chat.id, chat.type, chatTitle(chat), claimed.language],
      )
    ).rows[0]!;
    await db.query(`UPDATE telegram_link_codes SET chat_row_id = $2 WHERE id = $1`, [claimed.id, row.id]);
    await db.query(
      `INSERT INTO audit_logs (organization_id, action, target_type, target_id, metadata)
       VALUES ($1,'notification_channel.telegram_chat_linked','notification_channel',$2,$3)`,
      [ch.organization_id, ch.id, JSON.stringify({ chat_type: chat.type, title: chatTitle(chat) })],
    );
    return claimed.language;
  });
  const lang: Lang = linked ?? 'en';
  await telegramCall(ch.config, botToken, 'sendMessage', { chat_id: chat.id, text: linked ? TEXT.linked[lang](ch.name) : `${TEXT.badCode.en}\n\n${TEXT.badCode.ar}` });
}

async function chatLanguage(ch: PolledChannel, chat: TgChat): Promise<Lang | null> {
  const row = await withSystem(
    async (db) => (await db.query<{ language: Lang }>(`SELECT language FROM telegram_chats WHERE channel_id = $1 AND chat_id = $2`, [ch.id, chat.id])).rows[0],
  );
  if (row) return row.language;
  // The chat typed in before QR linking existed (a numeric ID or a public @channel name).
  const legacy = ch.config.chat_id;
  if (legacy && (legacy === String(chat.id) || (chat.username && legacy.toLowerCase() === `@${chat.username.toLowerCase()}`))) return 'en';
  return null;
}

async function pressButton(ch: PolledChannel, botToken: string, q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
  const answer = (text: string) => telegramCall(ch.config, botToken, 'answerCallbackQuery', { callback_query_id: q.id, text: text.slice(0, 200), show_alert: false });
  const chat = q.message?.chat;
  if (!q.data?.startsWith(TELEGRAM_CALLBACK_PREFIX) || !chat) return void (await answer(`${TEXT.failed.en}`));
  const lang = await chatLanguage(ch, chat);
  if (!lang) return void (await answer(`${TEXT.notLinked.en} / ${TEXT.notLinked.ar}`));
  const token = q.data.slice(TELEGRAM_CALLBACK_PREFIX.length);
  try {
    const r = await redeemActionToken(token, null, new Date(), { channelId: ch.id, via: { telegram_chat_id: String(chat.id) } });
    await answer(r.kind === 'allow_device' ? TEXT.allowed[lang](r.device.label) : TEXT.paused[lang](r.device.label));
    // The buttons go away so nobody presses a used one.
    if (q.message) {
      await telegramCall(ch.config, botToken, 'editMessageReplyMarkup', { chat_id: chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    }
  } catch (err) {
    const code = err instanceof AppError ? err.code : '';
    await answer(code === 'action_used' ? TEXT.used[lang] : code === 'action_expired' ? TEXT.expired[lang] : TEXT.failed[lang]);
  }
}

/** Read one channel's new updates once and act on them. Records the read position and the last error. */
export async function pollTelegramChannel(channelId: string): Promise<void> {
  const ch = await withSystem(
    async (db) =>
      (
        await db.query<PolledChannel>(
          `SELECT id, organization_id, name, config, secret_encrypted FROM notification_channels WHERE id = $1 AND kind = 'telegram' AND enabled`,
          [channelId],
        )
      ).rows[0],
  );
  if (!ch) return;
  const botToken = (JSON.parse(decryptSecret(ch.secret_encrypted)) as { bot_token: string }).bot_token;
  const offset = Number(
    (await withSystem(async (db) => (await db.query<{ next_offset: string }>(`SELECT next_offset FROM telegram_poll_state WHERE channel_id = $1`, [ch.id])).rows[0]))
      ?.next_offset ?? 0,
  );
  const save = (next: number, error: string | null) =>
    withSystem((db) =>
      db.query(
        `INSERT INTO telegram_poll_state (channel_id, organization_id, next_offset, last_poll_at, last_error, updated_at)
         VALUES ($1,$2,$3,now(),$4,now())
         ON CONFLICT (channel_id) DO UPDATE SET next_offset = EXCLUDED.next_offset, last_poll_at = now(), last_error = EXCLUDED.last_error, updated_at = now()`,
        [ch.id, ch.organization_id, next, error],
      ),
    );
  let reply: TelegramReply;
  try {
    reply = await telegramCall(ch.config, botToken, 'getUpdates', { offset, limit: 50, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  } catch (err) {
    await save(offset, redact(err instanceof Error ? err.message : String(err), botToken).slice(0, 200));
    return;
  }
  if (!reply.ok || !Array.isArray(reply.result)) {
    await save(offset, redact(`Telegram responded with HTTP ${reply.status}${reply.description ? `: ${reply.description}` : ''}`, botToken).slice(0, 200));
    return;
  }
  let next = offset;
  for (const u of reply.result as TgUpdate[]) {
    if (typeof u?.update_id !== 'number') continue;
    next = Math.max(next, u.update_id + 1);
    try {
      const text = u.message?.text?.trim();
      const start = text ? /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/.exec(text) : null;
      if (u.message && start) {
        if (start[1]) await bindChat(ch, botToken, u.message.chat, start[1]);
        else await telegramCall(ch.config, botToken, 'sendMessage', { chat_id: u.message.chat.id, text: `${TEXT.badCode.en}\n\n${TEXT.badCode.ar}` });
      } else if (u.callback_query) {
        await pressButton(ch, botToken, u.callback_query);
      }
    } catch (err) {
      logger.warn({ channel_id: ch.id, update_id: u.update_id, err: redact(err instanceof Error ? err.message : String(err), botToken) }, 'Telegram update not handled');
    }
  }
  await save(next, null);
}

/** The polling job: every enabled Telegram channel, side by side. */
export async function pollTelegramChannels(): Promise<void> {
  const ids = await withSystem(
    async (db) => (await db.query<{ id: string }>(`SELECT id FROM notification_channels WHERE kind = 'telegram' AND enabled ORDER BY created_at LIMIT 200`)).rows,
  );
  await Promise.all(
    ids.map((r) =>
      pollTelegramChannel(r.id).catch((err: unknown) => logger.warn({ channel_id: r.id, err: err instanceof Error ? err.message : String(err) }, 'Telegram poll failed')),
    ),
  );
}

// ── Settings routes ──

export const telegramRouter: Router = Router();

const PATHS = (suffix: string) => [`/notification-channels/:id${suffix}`, `/notifications/channels/:id${suffix}`];

async function loadTelegramChannel(organizationId: string, id: string): Promise<{ config: TelegramConfig; secret_encrypted: string }> {
  const row = await withTenant(
    organizationId,
    async (db) =>
      (await db.query<{ kind: string; config: TelegramConfig; secret_encrypted: string }>(`SELECT kind, config, secret_encrypted FROM notification_channels WHERE id = $1`, [id]))
        .rows[0],
  );
  if (!row) throw notFound('Channel');
  if (row.kind !== 'telegram') throw new AppError(400, 'not_telegram_channel', 'This is not a Telegram channel');
  return row;
}

/** A one-time QR link for this channel's bot. Asks Telegram for the bot's name first (getMe). */
telegramRouter.post(PATHS('/telegram-link'), requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { language } = parse(z.object({ language: z.enum(['en', 'ar']).default('en') }).strict(), req.body ?? {});
  const ch = await loadTelegramChannel(ctx.organizationId, id);
  const botToken = (JSON.parse(decryptSecret(ch.secret_encrypted)) as { bot_token: string }).bot_token;
  let me: TelegramReply;
  try {
    me = await telegramCall(ch.config, botToken, 'getMe', {});
  } catch (err) {
    throw new AppError(502, 'telegram_unreachable', `Telegram could not be reached: ${redact(err instanceof Error ? err.message : String(err), botToken).slice(0, 120)}`);
  }
  const username = (me.result as { username?: unknown } | undefined)?.username;
  if (!me.ok || typeof username !== 'string' || !/^[A-Za-z0-9_]{3,64}$/.test(username)) {
    throw new AppError(502, 'telegram_bot_rejected', `Telegram did not accept the bot token${me.description ? `: ${me.description}` : ''}`);
  }
  const code = randomToken(24);
  const expires = new Date(Date.now() + LINK_CODE_MINUTES * 60_000);
  await withTenant(ctx.organizationId, async (db) => {
    await db.query(`UPDATE notification_channels SET config = config || jsonb_build_object('bot_username', $2::text) WHERE id = $1`, [id, username]);
    await db.query(
      `INSERT INTO telegram_link_codes (organization_id, channel_id, code_hash, language, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.organizationId, id, sha256(code), language, ctx.userId, expires],
    );
    await audit(db, req, 'notification_channel.telegram_link_created', { type: 'notification_channel', id });
  });
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ url: `https://t.me/${username}?start=${code}`, bot_username: username, expires_at: expires.toISOString() });
});

/** The chats bound to the channel and how reading the bot's updates goes. */
telegramRouter.get(PATHS('/telegram-chats'), requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const ch = await loadTelegramChannel(ctx.organizationId, id);
  const out = await withTenant(ctx.organizationId, async (db) => {
    const chats = await db.query(`SELECT id, chat_type, title, language, linked_at FROM telegram_chats WHERE channel_id = $1 ORDER BY linked_at`, [id]);
    const poll = (
      await db.query<{ last_poll_at: Date | null; last_error: string | null }>(`SELECT last_poll_at, last_error FROM telegram_poll_state WHERE channel_id = $1`, [id])
    ).rows[0];
    return { chats: chats.rows, poll };
  });
  res.json({
    items: out.chats,
    legacy_chat_id: ch.config.chat_id ?? null,
    bot_username: ch.config.bot_username ?? null,
    polling: {
      last_poll_at: out.poll?.last_poll_at?.toISOString() ?? null,
      last_error: out.poll?.last_error ?? null,
      healthy: !!out.poll?.last_poll_at && !out.poll.last_error && Date.now() - out.poll.last_poll_at.getTime() < POLL_HEALTHY_MS,
    },
  });
});

telegramRouter.delete(PATHS('/telegram-chats/:chatId'), requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { chatId } = parse(z.object({ chatId: z.uuid() }), { chatId: req.params.chatId });
  await loadTelegramChannel(ctx.organizationId, id);
  await withTenant(ctx.organizationId, async (db) => {
    const deleted = await db.query(`DELETE FROM telegram_chats WHERE id = $1 AND channel_id = $2`, [chatId, id]);
    if (!deleted.rowCount) throw notFound('Chat');
    await audit(db, req, 'notification_channel.telegram_chat_removed', { type: 'notification_channel', id }, { chat: chatId });
  });
  res.status(204).end();
});
