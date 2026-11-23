import type { NotificationChannel, NotificationEscalation } from '@nigafiy/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { encryptSecret, randomToken } from '../../common/crypto.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { env } from '../../config/env.ts';
import { withTenant } from '../../infrastructure/db.ts';

export const notificationsRouter: Router = Router();

// The signing secret / bot token / webhook secret URL is never part of any SELECT that leaves this module.
const CHANNEL_SELECT = `
  SELECT c.id, c.kind, c.name, c.url, c.config, c.min_severity, c.event_types, c.enabled, c.use_for_account_emails, c.created_at,
         d.status AS last_delivery_status, coalesce(d.delivered_at, d.created_at) AS last_delivery_at, d.last_error AS last_delivery_error
    FROM notification_channels c
    LEFT JOIN LATERAL (SELECT status, delivered_at, created_at, last_error FROM notification_deliveries
                        WHERE channel_id = c.id ORDER BY created_at DESC LIMIT 1) d ON true`;

const ESCALATION_SELECT = `
  SELECT p.id, p.site_id, s.name AS site_name, p.name, p.channel_id,
         c.name AS channel_name, c.kind AS channel_kind,
         p.min_severity, p.delay_minutes, p.repeat_interval_minutes, p.max_repeats,
         p.enabled, p.created_at, p.updated_at
    FROM notification_escalations p
    JOIN notification_channels c ON c.id = p.channel_id
    LEFT JOIN sites s ON s.id = p.site_id`;

const common = {
  name: z.string().trim().min(1).max(80),
  min_severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  event_types: z.array(z.string().max(60)).max(30).nullable().default(null),
};

const webhookInput = z.object({
  kind: z.literal('webhook').default('webhook'),
  url: z.url().max(500),
  use_for_account_emails: z.literal(false).optional(),
  ...common,
});

const address = z.email().max(254);
const emailInput = z.object({
  kind: z.literal('email'),
  recipients: z.array(address).min(1).max(10),
  use_for_account_emails: z.boolean().default(false),
  smtp: z
    .object({
      host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, 'Enter a host name or IPv4 address'),
      port: z.number().int().min(1).max(65535),
      security: z.enum(['tls', 'starttls', 'none']),
      username: z.string().max(254).optional(),
      password: z.string().max(500).optional(),
      from: address,
    })
    .strict(),
  ...common,
});

const telegramInput = z.object({
  kind: z.literal('telegram'),
  bot_token: z
    .string()
    .trim()
    .min(20)
    .max(200)
    .regex(/^\d+:[A-Za-z0-9_-]{15,}$/, 'Enter a valid Telegram bot token from @BotFather'),
  chat_id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^(-?\d+|@[A-Za-z0-9_]{4,})$/, 'Enter a numeric chat ID or @channel username'),
  message_thread_id: z.number().int().positive().max(2_147_483_647).optional(),
  api_base: z.url().max(200).optional(),
  ...common,
});

const slackInput = z.object({
  kind: z.literal('slack'),
  webhook_url: z.url().max(500),
  ...common,
});

const discordInput = z.object({
  kind: z.literal('discord'),
  webhook_url: z.url().max(500),
  ...common,
});

const ntfyInput = z.object({
  kind: z.literal('ntfy'),
  server_url: z.url().max(300).default('https://ntfy.sh'),
  topic: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'Topic may contain letters, digits, hyphens and underscores'),
  token: z.string().trim().min(1).max(256).optional(),
  username: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(1).max(256).optional(),
  ...common,
});

// Requests without "kind" are webhooks, as before email existed.
const channelInput = z.union([emailInput, telegramInput, slackInput, discordInput, ntfyInput, webhookInput]);

function assertDestinationUrl(raw: string, allowedHosts?: readonly string[]): URL {
  const url = new URL(raw);
  if (url.username || url.password) throw new AppError(400, 'invalid_url', 'Do not put credentials in the URL');
  if (url.protocol !== 'https:' && !(env.ALLOW_PRIVATE_WEBHOOKS && url.protocol === 'http:')) {
    throw new AppError(400, 'invalid_url', 'URL must use https://');
  }
  if (allowedHosts && !env.ALLOW_PRIVATE_WEBHOOKS) {
    const h = url.hostname.toLowerCase();
    const ok = allowedHosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
    if (!ok) throw new AppError(400, 'invalid_url', `URL host must belong to ${allowedHosts.join(' or ')}`);
  }
  return url;
}

notificationsRouter.get(['/notification-channels', '/notifications/channels'], requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const result = await withTenant(ctx.organizationId, (db) => db.query<NotificationChannel>(`${CHANNEL_SELECT} ORDER BY c.created_at`));
  res.json({ items: result.rows });
});

notificationsRouter.post(['/notification-channels', '/notifications/channels'], requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  if ((req.body as { kind?: string; use_for_account_emails?: boolean } | undefined)?.use_for_account_emails && (req.body as { kind?: string }).kind !== 'email') {
    throw new AppError(400, 'not_email_channel', 'Only an email channel can send account emails');
  }
  const body = parse(channelInput, req.body);
  let url: string;
  let config: Record<string, unknown> = {};
  let sealed: string;
  let signingSecret: string | null = null;
  const useForAccountEmails = body.kind === 'email' ? body.use_for_account_emails : false;

  if (body.kind === 'email') {
    const { password, username, ...smtp } = body.smtp;
    if (password && !username) throw new AppError(400, 'invalid_smtp', 'A password needs a user name');
    // A mail password is never sent over an unencrypted connection.
    if (username && smtp.security === 'none') throw new AppError(400, 'invalid_smtp', 'Signing in to the mail server needs TLS or STARTTLS');
    url = `mailto:${body.recipients.join(',')}`;
    config = { ...smtp, username: username || null };
    sealed = encryptSecret(JSON.stringify(password ? { password } : {}));
  } else if (body.kind === 'telegram') {
    if (body.api_base) assertDestinationUrl(body.api_base);
    url = `telegram://${body.chat_id}`;
    config = {
      chat_id: body.chat_id,
      ...(body.message_thread_id !== undefined ? { message_thread_id: body.message_thread_id } : {}),
      ...(body.api_base ? { api_base: body.api_base.replace(/\/+$/, '') } : {}),
    };
    sealed = encryptSecret(JSON.stringify({ bot_token: body.bot_token }));
  } else if (body.kind === 'slack') {
    const parsed = assertDestinationUrl(body.webhook_url, ['hooks.slack.com', 'hooks.gov-slack.com']);
    url = `slack://${parsed.host}/services/***`;
    config = { host: parsed.host };
    sealed = encryptSecret(JSON.stringify({ webhook_url: body.webhook_url }));
  } else if (body.kind === 'discord') {
    const parsed = assertDestinationUrl(body.webhook_url, ['discord.com', 'discordapp.com']);
    url = `discord://${parsed.host}/api/webhooks/***`;
    config = { host: parsed.host };
    sealed = encryptSecret(JSON.stringify({ webhook_url: body.webhook_url }));
  } else if (body.kind === 'ntfy') {
    if (body.password && !body.username) throw new AppError(400, 'invalid_auth', 'A password needs a user name');
    if (body.token && (body.username || body.password)) throw new AppError(400, 'invalid_auth', 'Use either an access token or username/password, not both');
    const parsed = assertDestinationUrl(body.server_url);
    const serverBase = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    url = `${serverBase}/${body.topic}`;
    config = { server_url: serverBase, topic: body.topic, ...(body.username ? { username: body.username } : {}) };
    sealed = encryptSecret(JSON.stringify({ ...(body.token ? { token: body.token } : {}), ...(body.password ? { password: body.password } : {}) }));
  } else {
    assertDestinationUrl(body.url);
    url = body.url;
    signingSecret = `whsec_${randomToken(32)}`;
    sealed = encryptSecret(signingSecret);
  }

  const channel = await withTenant(ctx.organizationId, async (db) => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO notification_channels (organization_id, kind, name, url, config, secret_encrypted, min_severity, event_types, use_for_account_emails)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ctx.organizationId, body.kind, body.name, url, JSON.stringify(config), sealed, body.min_severity, body.event_types, useForAccountEmails],
    );
    const id = inserted.rows[0]!.id;
    // The audit trail records that a channel was added, never its token, password or secret URL.
    await audit(db, req, 'notification_channel.created', { type: 'notification_channel', id }, {
      name: body.name,
      kind: body.kind,
      use_for_account_emails: useForAccountEmails,
    });
    return (await db.query<NotificationChannel>(`${CHANNEL_SELECT} WHERE c.id = $1`, [id])).rows[0]!;
  });
  // A webhook signing secret is returned exactly once so the receiver can verify signatures; stored encrypted.
  res.status(201).json({ channel, signing_secret: signingSecret });
});

notificationsRouter.patch(['/notification-channels/:id', '/notifications/channels/:id'], requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(
    z
      .object({
        enabled: z.boolean().optional(),
        min_severity: z.enum(['info', 'warning', 'critical']).optional(),
        /** Email channels only: also send account mail (invitations, password resets) through this channel. Off by default. */
        use_for_account_emails: z.boolean().optional(),
      })
      .strict(),
    req.body,
  );
  const channel = await withTenant(ctx.organizationId, async (db) => {
    const kind = (await db.query<{ kind: string }>(`SELECT kind FROM notification_channels WHERE id = $1`, [id])).rows[0]?.kind;
    if (!kind) throw notFound('Channel');
    if (body.use_for_account_emails && kind !== 'email') throw new AppError(400, 'not_email_channel', 'Only an email channel can send account emails');
    const updated = await db.query(
      `UPDATE notification_channels SET enabled = coalesce($2, enabled), min_severity = coalesce($3, min_severity),
              use_for_account_emails = coalesce($4, use_for_account_emails) WHERE id = $1`,
      [id, body.enabled ?? null, body.min_severity ?? null, body.use_for_account_emails ?? null],
    );
    if (!updated.rowCount) throw notFound('Channel');
    await audit(db, req, 'notification_channel.updated', { type: 'notification_channel', id }, body);
    return (await db.query<NotificationChannel>(`${CHANNEL_SELECT} WHERE c.id = $1`, [id])).rows[0]!;
  });
  res.json(channel);
});

notificationsRouter.delete(['/notification-channels/:id', '/notifications/channels/:id'], requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const deleted = await db.query(`DELETE FROM notification_channels WHERE id = $1`, [id]);
    if (!deleted.rowCount) throw notFound('Channel');
    await audit(db, req, 'notification_channel.deleted', { type: 'notification_channel', id });
  });
  res.status(204).end();
});

/** Queue a clearly-labelled test notification to one channel. */
notificationsRouter.post(['/notification-channels/:id/test', '/notifications/channels/:id/test'], requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM notification_channels WHERE id = $1`, [id])).rowCount) throw notFound('Channel');
    const event = await db.query<{ id: string }>(
      `INSERT INTO network_events (organization_id, type, severity, title, details, source, occurred_at)
       VALUES ($1,'notification_test','info','Test notification from Nigafiy',$2,'platform',now()) RETURNING id`,
      [ctx.organizationId, JSON.stringify({ requested_by: ctx.userEmail, test: true })],
    );
    await db.query(`INSERT INTO notification_deliveries (organization_id, channel_id, event_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      ctx.organizationId,
      id,
      event.rows[0]!.id,
    ]);
  });
  res.status(202).json({ ok: true });
});

// ── Escalation policies ───────────────────────────────────────────────────────

const escalationCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    site_id: z.uuid().nullable().optional(),
    channel_id: z.uuid(),
    min_severity: z.enum(['info', 'warning', 'critical']).default('critical'),
    delay_minutes: z.number().int().min(1).max(1440),
    repeat_interval_minutes: z.number().int().min(5).max(1440).nullable().optional(),
    max_repeats: z.number().int().min(1).max(10).default(1),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.max_repeats === 1 || v.repeat_interval_minutes != null, {
    message: 'repeat_interval_minutes is required when max_repeats > 1',
    path: ['repeat_interval_minutes'],
  });

const escalationPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    channel_id: z.uuid().optional(),
    min_severity: z.enum(['info', 'warning', 'critical']).optional(),
    delay_minutes: z.number().int().min(1).max(1440).optional(),
    repeat_interval_minutes: z.number().int().min(5).max(1440).nullable().optional(),
    max_repeats: z.number().int().min(1).max(10).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

notificationsRouter.get(['/notifications/escalations', '/notification-escalations'], requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const result = await withTenant(ctx.organizationId, (db) => db.query<NotificationEscalation>(`${ESCALATION_SELECT} ORDER BY p.delay_minutes ASC, p.created_at ASC`));
  res.json({ items: result.rows });
});

notificationsRouter.post(['/notifications/escalations', '/notification-escalations'], requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(escalationCreateSchema, req.body);
  const policy = await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM notification_channels WHERE id = $1`, [body.channel_id])).rowCount) {
      throw notFound('Channel');
    }
    if (body.site_id && !(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount) {
      throw notFound('Site');
    }
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO notification_escalations (organization_id, site_id, name, channel_id, min_severity, delay_minutes, repeat_interval_minutes, max_repeats, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        ctx.organizationId,
        body.site_id ?? null,
        body.name,
        body.channel_id,
        body.min_severity,
        body.delay_minutes,
        body.max_repeats > 1 ? body.repeat_interval_minutes ?? null : null,
        body.max_repeats,
        body.enabled,
      ],
    );
    const id = inserted.rows[0]!.id;
    await audit(db, req, 'notification_escalation.created', { type: 'notification_escalation', id }, body);
    return (await db.query<NotificationEscalation>(`${ESCALATION_SELECT} WHERE p.id = $1`, [id])).rows[0]!;
  });
  res.status(201).json(policy);
});

notificationsRouter.patch(['/notifications/escalations/:id', '/notification-escalations/:id'], requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(escalationPatchSchema, req.body);
  const policy = await withTenant(ctx.organizationId, async (db) => {
    const existing = (await db.query<{ max_repeats: number; repeat_interval_minutes: number | null }>(`SELECT max_repeats, repeat_interval_minutes FROM notification_escalations WHERE id = $1`, [id])).rows[0];
    if (!existing) throw notFound('Escalation policy');
    if (body.channel_id && !(await db.query(`SELECT 1 FROM notification_channels WHERE id = $1`, [body.channel_id])).rowCount) {
      throw notFound('Channel');
    }
    const nextMax = body.max_repeats ?? existing.max_repeats;
    const nextRepeat = body.repeat_interval_minutes !== undefined ? body.repeat_interval_minutes : existing.repeat_interval_minutes;
    if (nextMax > 1 && !nextRepeat) {
      throw new AppError(400, 'invalid_escalation', 'repeat_interval_minutes is required when max_repeats > 1');
    }
    await db.query(
      `UPDATE notification_escalations
          SET name = coalesce($2, name),
              channel_id = coalesce($3, channel_id),
              min_severity = coalesce($4, min_severity),
              delay_minutes = coalesce($5, delay_minutes),
              repeat_interval_minutes = $6,
              max_repeats = $7,
              enabled = coalesce($8, enabled),
              updated_at = now()
        WHERE id = $1`,
      [id, body.name ?? null, body.channel_id ?? null, body.min_severity ?? null, body.delay_minutes ?? null, nextMax > 1 ? nextRepeat : null, nextMax, body.enabled ?? null],
    );
    await audit(db, req, 'notification_escalation.updated', { type: 'notification_escalation', id }, body);
    return (await db.query<NotificationEscalation>(`${ESCALATION_SELECT} WHERE p.id = $1`, [id])).rows[0]!;
  });
  res.json(policy);
});

notificationsRouter.delete(['/notifications/escalations/:id', '/notification-escalations/:id'], requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const deleted = await db.query(`DELETE FROM notification_escalations WHERE id = $1`, [id]);
    if (!deleted.rowCount) throw notFound('Escalation policy');
    await audit(db, req, 'notification_escalation.deleted', { type: 'notification_escalation', id });
  });
  res.status(204).end();
});
