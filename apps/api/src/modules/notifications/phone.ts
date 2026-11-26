import type { Db } from '../../infrastructure/db.ts';
import { systemPool } from '../../infrastructure/db.ts';
import { encryptSecret } from '../../common/crypto.ts';
import type { NotificationAction } from '@nigafiy/shared-types/notification-actions';
import type { NotificationEvent } from './email.ts';
import { buildPushMessage } from './webpush.ts';

/**
 * Network alerts on admin phones (migration 067, docs/roadmap/2026-11-26-admin-phones.md).
 *
 * The "Admin phones" channel takes important problems (warning and up) and the "resolved" event
 * types. A delivery becomes one phone_alerts row per active admin phone; the phone collects them
 * with its heartbeat. A "resolved" event reaches the phones only when they were told about that
 * problem (same device, check or Sensor in the last 7 days), so a phone coming back online, or any
 * other everyday change, never makes noise.
 */

export const PHONE_CHANNEL_NAME = 'Admin phones';
export const RESOLVED_TYPES = ['device_online', 'check_recovered', 'collector_online', 'ip_conflict_resolved', 'dhcp_offer_restored'];

/** The organization's "Admin phones" channel, made the first time. Runs as the system role. */
export async function ensurePhoneChannel(db: Db, organizationId: string): Promise<string> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('phone-channel:' || $1))`, [organizationId]);
  const found = (await db.query<{ id: string }>(`SELECT id FROM notification_channels WHERE organization_id = $1 AND kind = 'phone' ORDER BY created_at LIMIT 1`, [organizationId])).rows[0];
  if (found) return found.id;
  const made = await db.query<{ id: string }>(
    `INSERT INTO notification_channels (organization_id, kind, name, url, config, secret_encrypted, min_severity, event_types)
     VALUES ($1, 'phone', $2, 'phone://admins', '{}', $3, 'warning', $4) RETURNING id`,
    [organizationId, PHONE_CHANNEL_NAME, encryptSecret('{}'), RESOLVED_TYPES],
  );
  return made.rows[0]!.id;
}

/** Hands one delivery to every active admin phone. Returns an error text, or null when done. */
export async function deliverToPhones(organizationId: string, event: NotificationEvent & { actions?: NotificationAction[] }, organizationName: string): Promise<string | null> {
  // The channel's Test button sends an info event: it is not a "resolved" message, show it as is.
  const resolved = event.severity === 'info' && event.type !== 'notification_test';
  if (resolved) {
    if (!RESOLVED_TYPES.includes(event.type)) return null;
    const told = await systemPool.query(
      `SELECT 1
         FROM phone_alerts pa
         JOIN network_events p ON p.id = pa.event_id
         JOIN network_events n ON n.id = $2
        WHERE pa.organization_id = $1 AND NOT pa.resolved AND pa.created_at > now() - interval '7 days'
          AND ((n.device_id IS NOT NULL AND p.device_id = n.device_id)
            OR (n.check_id IS NOT NULL AND p.check_id = n.check_id)
            OR (n.collector_id IS NOT NULL AND p.collector_id = n.collector_id))
        LIMIT 1`,
      [organizationId, event.id],
    );
    if (!told.rowCount) return null;
  }
  const m = buildPushMessage({ ...event, actions: [] }, organizationName, 'en');
  await systemPool.query(
    `INSERT INTO phone_alerts (organization_id, endpoint_id, event_id, title, body, path, tag, severity, resolved)
     SELECT $1, e.id, $2, $3, $4, $5, $6, $7, $8
       FROM endpoints e
      WHERE e.organization_id = $1 AND e.status = 'active' AND e.platform = 'android' AND e.phone_role = 'admin'
     ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
    [organizationId, event.id, m.title.slice(0, 200), m.body.slice(0, 800), m.url.slice(0, 300), m.tag, event.severity, resolved],
  );
  return null;
}

export interface PhoneAlert {
  id: string;
  title: string;
  body: string;
  path: string;
  tag: string;
  severity: string;
  resolved: boolean;
  created_at: string;
}

/**
 * The alerts an admin phone has not shown yet, oldest first, at most 10, marked delivered. Older than
 * a day is no longer news: those are dropped (the dashboard still lists them).
 */
export async function takePhoneAlerts(endpointId: string): Promise<PhoneAlert[]> {
  await systemPool.query(`UPDATE phone_alerts SET delivered_at = now() WHERE endpoint_id = $1 AND delivered_at IS NULL AND created_at < now() - interval '1 day'`, [endpointId]);
  const r = await systemPool.query<PhoneAlert>(
    `UPDATE phone_alerts SET delivered_at = now()
      WHERE id IN (SELECT id FROM phone_alerts WHERE endpoint_id = $1 AND delivered_at IS NULL ORDER BY created_at LIMIT 10)
      RETURNING id, title, body, path, tag, severity, resolved, created_at`,
    [endpointId],
  );
  return r.rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}
