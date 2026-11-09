import type { Severity } from '@lan-detective/shared-types';
import type { Db } from '../../infrastructure/db.ts';

export interface NewEvent {
  siteId?: string | null;
  deviceId?: string | null;
  checkId?: string | null;
  collectorId?: string | null;
  type: string;
  severity: Severity;
  title: string;
  /** Evidence: the observations that led to this event. Must be inspectable by the user. */
  details: Record<string, unknown>;
  source: 'collector' | 'platform';
  occurredAt: Date;
}

export const REALTIME_CHANNEL = 'ld_realtime';

/** Tell connected dashboards of this organization that something changed (delivered on COMMIT). */
export async function notifyRealtime(db: Db, organizationId: string, topic: 'events' | 'devices' | 'checks' | 'collectors'): Promise<void> {
  await db.query(`SELECT pg_notify($1, $2)`, [REALTIME_CHANNEL, JSON.stringify({ org: organizationId, topic })]);
}

/**
 * Record an event on the timeline and queue notifications for matching channels.
 * Works both inside a tenant transaction and a system transaction because every
 * statement filters by organization explicitly.
 */
export async function emitEvent(db: Db, organizationId: string, ev: NewEvent): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO network_events
       (organization_id, site_id, device_id, check_id, collector_id, type, severity, title, details, source, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      organizationId,
      ev.siteId ?? null,
      ev.deviceId ?? null,
      ev.checkId ?? null,
      ev.collectorId ?? null,
      ev.type,
      ev.severity,
      ev.title,
      JSON.stringify(ev.details),
      ev.source,
      ev.occurredAt,
    ],
  );
  const eventId = inserted.rows[0]!.id;

  await db.query(
    `INSERT INTO notification_deliveries (organization_id, channel_id, event_id)
     SELECT c.organization_id, c.id, $2
       FROM notification_channels c
      WHERE c.organization_id = $1
        AND c.enabled
        AND ( array_position(ARRAY['info','warning','critical'], $3::text)
                >= array_position(ARRAY['info','warning','critical'], c.min_severity)
              OR $4 = ANY (coalesce(c.event_types, '{}')) )
     ON CONFLICT DO NOTHING`,
    [organizationId, eventId, ev.severity, ev.type],
  );
  await notifyRealtime(db, organizationId, 'events');
  return eventId;
}
