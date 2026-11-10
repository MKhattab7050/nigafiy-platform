import { Router } from 'express';
import { z } from 'zod';
import type { NotificationChannel } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { encryptSecret, randomToken } from '../../common/crypto.ts';
import { env } from '../../config/env.ts';
import { withTenant } from '../../infrastructure/db.ts';

export const notificationsRouter: Router = Router();

// The signing secret is never part of any SELECT that leaves this module.
const CHANNEL_SELECT = `
  SELECT c.id, c.kind, c.name, c.url, c.config, c.min_severity, c.event_types, c.enabled, c.created_at,
         d.status AS last_delivery_status, coalesce(d.delivered_at, d.created_at) AS last_delivery_at, d.last_error AS last_delivery_error
    FROM notification_channels c
    LEFT JOIN LATERAL (SELECT status, delivered_at, created_at, last_error FROM notification_deliveries
                        WHERE channel_id = c.id ORDER BY created_at DESC LIMIT 1) d ON true`;

const common = {
  name: z.string().trim().min(1).max(80),
  min_severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  event_types: z.array(z.string().max(60)).max(30).nullable().default(null),
};
const webhookInput = z.object({ kind: z.literal('webhook').default('webhook'), url: z.url().max(500), ...common });
const address = z.email().max(254);
const emailInput = z.object({
  kind: z.literal('email'),
  recipients: z.array(address).min(1).max(10),
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
// Requests without "kind" are webhooks, as before email existed.
const channelInput = z.union([emailInput, webhookInput]);

function assertWebhookUrl(raw: string): void {
  const url = new URL(raw);
  if (url.username || url.password) throw new AppError(400, 'invalid_url', 'Do not put credentials in the webhook URL');
  if (url.protocol !== 'https:' && !(env.ALLOW_PRIVATE_WEBHOOKS && url.protocol === 'http:')) {
    throw new AppError(400, 'invalid_url', 'Webhook URL must use https://');
  }
}

notificationsRouter.get('/notification-channels', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const result = await withTenant(ctx.organizationId, (db) => db.query<NotificationChannel>(`${CHANNEL_SELECT} ORDER BY c.created_at`));
  res.json({ items: result.rows });
});

notificationsRouter.post('/notification-channels', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(channelInput, req.body);
  let url: string;
  let config: Record<string, unknown> = {};
  let sealed: string;
  let signingSecret: string | null = null;
  if (body.kind === 'email') {
    const { password, username, ...smtp } = body.smtp;
    if (password && !username) throw new AppError(400, 'invalid_smtp', 'A password needs a user name');
    // A mail password is never sent over an unencrypted connection.
    if (username && smtp.security === 'none') throw new AppError(400, 'invalid_smtp', 'Signing in to the mail server needs TLS or STARTTLS');
    url = `mailto:${body.recipients.join(',')}`;
    config = { ...smtp, username: username || null };
    sealed = encryptSecret(JSON.stringify(password ? { password } : {}));
  } else {
    assertWebhookUrl(body.url);
    url = body.url;
    signingSecret = `whsec_${randomToken(32)}`;
    sealed = encryptSecret(signingSecret);
  }
  const channel = await withTenant(ctx.organizationId, async (db) => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO notification_channels (organization_id, kind, name, url, config, secret_encrypted, min_severity, event_types)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ctx.organizationId, body.kind, body.name, url, JSON.stringify(config), sealed, body.min_severity, body.event_types],
    );
    const id = inserted.rows[0]!.id;
    // The audit trail records that a channel was added, never its password or signing secret.
    await audit(db, req, 'notification_channel.created', { type: 'notification_channel', id }, { name: body.name, kind: body.kind });
    return (await db.query<NotificationChannel>(`${CHANNEL_SELECT} WHERE c.id = $1`, [id])).rows[0]!;
  });
  // A webhook signing secret is returned exactly once so the receiver can verify signatures; stored encrypted.
  res.status(201).json({ channel, signing_secret: signingSecret });
});

notificationsRouter.patch('/notification-channels/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ enabled: z.boolean().optional(), min_severity: z.enum(['info', 'warning', 'critical']).optional() }).strict(), req.body);
  const channel = await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE notification_channels SET enabled = coalesce($2, enabled), min_severity = coalesce($3, min_severity) WHERE id = $1`,
      [id, body.enabled ?? null, body.min_severity ?? null],
    );
    if (!updated.rowCount) throw notFound('Channel');
    await audit(db, req, 'notification_channel.updated', { type: 'notification_channel', id }, body);
    return (await db.query<NotificationChannel>(`${CHANNEL_SELECT} WHERE c.id = $1`, [id])).rows[0]!;
  });
  res.json(channel);
});

notificationsRouter.delete('/notification-channels/:id', requireRole('admin'), async (req, res) => {
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
notificationsRouter.post('/notification-channels/:id/test', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM notification_channels WHERE id = $1`, [id])).rowCount) throw notFound('Channel');
    const event = await db.query<{ id: string }>(
      `INSERT INTO network_events (organization_id, type, severity, title, details, source, occurred_at)
       VALUES ($1,'notification_test','info','Test notification from LAN Detective',$2,'platform',now()) RETURNING id`,
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
