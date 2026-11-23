import type { Severity } from '@nigafiy/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { correlateEvent } from '../correlation/index.ts';
import { notifyRealtime } from '../realtime/index.ts';

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

/**
 * Record an event on the timeline and queue notifications for matching channels.
 * Works both inside a tenant transaction and a system transaction because every
 * statement filters by organization explicitly.
 */
export async function emitEvent(db: Db, organizationId: string, ev: NewEvent): Promise<string> {
  let inMaintenance = false;
  let maintenanceWindowId: string | null = null;
  if (ev.type !== 'maintenance_started' && ev.type !== 'maintenance_ended') {
    const matched = await db.query<{ id: string }>(
      `SELECT w.id
         FROM maintenance_windows w
        WHERE w.organization_id = $1
          AND maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, $2) IS NOT NULL
          AND (w.site_id IS NULL OR w.site_id = $3)
          AND (
            w.target_all
            OR ($4::uuid IS NOT NULL AND $4::uuid = ANY(w.device_ids))
            OR ($5::uuid IS NOT NULL AND $5::uuid = ANY(w.check_ids))
            OR ($6::uuid IS NOT NULL AND $6::uuid = ANY(w.collector_ids))
          )
        ORDER BY w.created_at
        LIMIT 1`,
      [
        organizationId,
        ev.occurredAt,
        ev.siteId ?? null,
        ev.deviceId ?? null,
        ev.checkId ?? null,
        ev.collectorId ?? null,
      ],
    );
    if (matched.rows[0]) {
      inMaintenance = true;
      maintenanceWindowId = matched.rows[0].id;
    }
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO network_events
       (organization_id, site_id, device_id, check_id, collector_id, type, severity, title, details, source, occurred_at, in_maintenance, maintenance_window_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
      inMaintenance,
      maintenanceWindowId,
    ],
  );
  const eventId = inserted.rows[0]!.id;

  if (!inMaintenance) {
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
  }
  await correlateEvent(db, organizationId, {
    id: eventId,
    type: ev.type,
    severity: ev.severity,
    title: ev.title,
    siteId: ev.siteId ?? null,
    checkId: ev.checkId ?? null,
    deviceId: ev.deviceId ?? null,
    collectorId: ev.collectorId ?? null,
    occurredAt: ev.occurredAt,
    inMaintenance,
  });
  await notifyRealtime(db, organizationId, 'events');
  return eventId;
}
