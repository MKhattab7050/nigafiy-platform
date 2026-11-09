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
  SELECT c.id, c.kind, c.name, c.url, c.min_severity, c.event_types, c.enabled, c.created_at,
         d.status AS last_delivery_status, coalesce(d.delivered_at, d.created_at) AS last_delivery_at
    FROM notification_channels c
    LEFT JOIN LATERAL (SELECT status, delivered_at, created_at FROM notification_deliveries
                        WHERE channel_id = c.id ORDER BY created_at DESC LIMIT 1) d ON true`;

const channelInput = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.url().max(500),
  min_severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  event_types: z.array(z.string().max(60)).max(30).nullable().default(null),
});

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
  assertWebhookUrl(body.url);
  const secret = `whsec_${randomToken(32)}`;
  const channel = await withTenant(ctx.organizationId, async (db) => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO notification_channels (organization_id, kind, name, url, secret_encrypted, min_severity, event_types)
       VALUES ($1,'webhook',$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.organizationId, body.name, body.url, encryptSecret(secret), body.min_severity, body.event_types],
    );
    const id = inserted.rows[0]!.id;
    await audit(db, req, 'notification_channel.created', { type: 'notification_channel', id }, { name: body.name });
    return (await db.query<NotificationChannel>(`${CHANNEL_SELECT} WHERE c.id = $1`, [id])).rows[0]!;
  });
  // Returned exactly once so the receiver can verify signatures; stored encrypted.
  res.status(201).json({ channel, signing_secret: secret });
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
