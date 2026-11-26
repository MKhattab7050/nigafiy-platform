import type { PushSettings } from '@nigafiy/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { encryptSecret, sha256 } from '../../common/crypto.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { type Db, withSystem, withTenant } from '../../infrastructure/db.ts';
import { checkPushKeys, validPushEndpoint, vapidKeys } from './webpush.ts';

// Phone / browser push (UX review item 11). A browser that says yes is added to the organization's
// "Phones (push)" channel, made on the first subscription; that channel keeps the usual severity and
// event filters and appears in the channel list (test, pause, delete as any other channel).

export const webPushRouter: Router = Router();

const PUSH_CHANNEL_NAME = 'Phones (push)';

const subscribeInput = z.object({
  endpoint: z.string().max(2000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  language: z.enum(['en', 'ar']).default('en'),
  label: z.string().trim().max(120).nullable().optional(),
});
const endpointInput = z.object({ endpoint: z.string().max(2000) });

async function pushChannelId(db: Db, organizationId: string, create: boolean): Promise<string | null> {
  // One push channel per organization, even when two browsers subscribe at the same moment.
  if (create) await db.query(`SELECT pg_advisory_xact_lock(hashtext('webpush-channel:' || $1))`, [organizationId]);
  const found = (await db.query<{ id: string }>(`SELECT id FROM notification_channels WHERE kind = 'push' ORDER BY created_at LIMIT 1`)).rows[0];
  if (found || !create) return found?.id ?? null;
  const made = await db.query<{ id: string }>(
    `INSERT INTO notification_channels (organization_id, kind, name, url, config, secret_encrypted, min_severity)
     VALUES ($1, 'push', $2, 'push://phones', '{}', $3, 'warning') RETURNING id`,
    [organizationId, PUSH_CHANNEL_NAME, encryptSecret('{}')],
  );
  return made.rows[0]!.id;
}

webPushRouter.get('/notifications/push', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const vapid = await vapidKeys();
  const out = await withTenant(ctx.organizationId, async (db) => {
    const channelId = await pushChannelId(db, ctx.organizationId, false);
    const channel = channelId
      ? (await db.query<NonNullable<PushSettings['channel']>>(`SELECT id, enabled, min_severity FROM notification_channels WHERE id = $1`, [channelId])).rows[0] ?? null
      : null;
    const subscriptions = channelId
      ? (
          await db.query<Omit<PushSettings['subscriptions'][number], 'user_email'> & { user_id: string | null }>(
            `SELECT s.id, s.endpoint_host, s.endpoint_hash, s.language, s.label, s.created_at, s.last_success_at, s.last_error, s.user_id
               FROM webpush_subscriptions s
              WHERE s.channel_id = $1 ORDER BY s.created_at`,
            [channelId],
          )
        ).rows
      : [];
    return { channel, subscriptions };
  });
  // The application role cannot read users; who turned push on is looked up with the system role.
  const userIds = [...new Set(out.subscriptions.map((x) => x.user_id).filter((x): x is string => x !== null))];
  const emails = new Map(
    userIds.length
      ? (await withSystem((db) => db.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = ANY($1::uuid[])`, [userIds]))).rows.map((u) => [u.id, u.email])
      : [],
  );
  const body: PushSettings = {
    public_key: vapid.publicKey,
    channel: out.channel,
    subscriptions: out.subscriptions.map(({ user_id, ...rest }) => ({ ...rest, user_email: user_id ? (emails.get(user_id) ?? null) : null })),
  };
  res.set('Cache-Control', 'no-store').json(body);
});

webPushRouter.post('/notifications/push/subscriptions', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(subscribeInput, req.body);
  const endpoint = validPushEndpoint(body.endpoint);
  if (!endpoint) throw new AppError(400, 'push_endpoint_invalid', 'This browser offered a push address Nigafiy does not recognise');
  try {
    checkPushKeys(body.keys);
  } catch {
    throw new AppError(400, 'push_keys_invalid', 'The browser sent push keys that cannot be used');
  }
  const hash = sha256(endpoint.href);
  const sealed = encryptSecret(JSON.stringify({ endpoint: endpoint.href, keys: body.keys }));
  const result = await withTenant(ctx.organizationId, async (db) => {
    const channelId = (await pushChannelId(db, ctx.organizationId, true))!;
    const row = (
      await db.query<{ id: string; inserted: boolean }>(
        `INSERT INTO webpush_subscriptions (organization_id, channel_id, user_id, endpoint_hash, endpoint_host, subscription_sealed, language, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (organization_id, endpoint_hash) DO UPDATE
            SET subscription_sealed = EXCLUDED.subscription_sealed, language = EXCLUDED.language, user_id = EXCLUDED.user_id,
                label = coalesce(EXCLUDED.label, webpush_subscriptions.label), channel_id = EXCLUDED.channel_id, last_error = NULL
         RETURNING id, (xmax = 0) AS inserted`,
        [ctx.organizationId, channelId, ctx.userId, hash, endpoint.hostname, sealed, body.language, body.label ?? null],
      )
    ).rows[0]!;
    await audit(db, req, 'notification.push.subscribed', { type: 'notification_channel', id: channelId }, { subscription_id: row.id, push_service: endpoint.hostname });
    return { id: row.id, channel_id: channelId, inserted: row.inserted };
  });
  res.status(result.inserted ? 201 : 200).json({ id: result.id, channel_id: result.channel_id });
});

/** The browser turned push off (or the user pressed "Turn off on this device"): forget it by its endpoint. */
webPushRouter.post('/notifications/push/unsubscribe', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { endpoint } = parse(endpointInput, req.body);
  const removed = await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<{ id: string; channel_id: string }>(`DELETE FROM webpush_subscriptions WHERE endpoint_hash = $1 RETURNING id, channel_id`, [
      sha256(validPushEndpoint(endpoint)?.href ?? endpoint),
    ]);
    for (const row of r.rows) await audit(db, req, 'notification.push.unsubscribed', { type: 'notification_channel', id: row.channel_id }, { subscription_id: row.id });
    return r.rowCount ?? 0;
  });
  res.json({ removed });
});

webPushRouter.delete('/notifications/push/subscriptions/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<{ channel_id: string }>(`DELETE FROM webpush_subscriptions WHERE id = $1 RETURNING channel_id`, [id]);
    if (!r.rowCount) throw notFound('Subscription');
    await audit(db, req, 'notification.push.unsubscribed', { type: 'notification_channel', id: r.rows[0]!.channel_id }, { subscription_id: id });
  });
  res.status(204).end();
});
