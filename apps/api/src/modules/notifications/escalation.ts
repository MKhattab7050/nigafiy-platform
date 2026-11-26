import { auditSystem } from '../../common/audit.ts';
import { withSystem } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { notifyRealtime } from '../realtime/index.ts';

interface DueEscalation {
  policy_id: string;
  policy_name: string;
  organization_id: string;
  channel_id: string;
  channel_name: string;
  incident_id: string;
  incident_number: number;
  incident_title: string;
  incident_severity: 'info' | 'warning' | 'critical';
  site_id: string | null;
  device_id: string | null;
  check_id: string | null;
  opened_at: Date;
  sent_count: number;
}

/**
 * Escalates incidents that remain `open` (unacknowledged and unresolved) beyond a policy's
 * `delay_minutes`, and optionally repeats up to `max_repeats` every `repeat_interval_minutes`.
 *
 * Each escalation creates one `incident_escalated` timeline event and queues delivery ONLY to the
 * policy's target channel (never broadcasting to every channel), and records a system audit entry.
 */
export async function runEscalations(now = new Date()): Promise<number> {
  let escalated = 0;
  await withSystem(async (db) => {
    const due = (
      await db.query<DueEscalation>(
        `SELECT p.id AS policy_id, p.name AS policy_name, p.organization_id,
                p.channel_id, c.name AS channel_name,
                i.id AS incident_id, i.number AS incident_number, i.title AS incident_title,
                i.severity AS incident_severity, i.site_id, i.device_id, i.check_id, i.opened_at,
                coalesce(ie.sent_count, 0) AS sent_count
           FROM notification_escalations p
           JOIN notification_channels c ON c.id = p.channel_id AND c.organization_id = p.organization_id AND c.enabled
           JOIN incidents i ON i.organization_id = p.organization_id
          LEFT JOIN incident_escalations ie ON ie.policy_id = p.id AND ie.incident_id = i.id
          WHERE p.enabled
            AND i.status = 'open'
            AND (p.site_id IS NULL OR p.site_id = i.site_id)
            AND array_position(ARRAY['info','warning','critical'], i.severity)
                  >= array_position(ARRAY['info','warning','critical'], p.min_severity)
            AND (
              (ie.policy_id IS NULL AND i.opened_at <= $1::timestamptz - make_interval(mins => p.delay_minutes))
              OR (
                ie.policy_id IS NOT NULL
                AND ie.sent_count < p.max_repeats
                AND p.repeat_interval_minutes IS NOT NULL
                AND ie.last_sent_at <= $1::timestamptz - make_interval(mins => p.repeat_interval_minutes)
              )
            )
          ORDER BY i.opened_at ASC
          LIMIT 50`,
        [now],
      )
    ).rows;

    const touchedOrgs = new Set<string>();
    for (const row of due) {
      await db.query('SAVEPOINT escalation_row');
      try {
        const nextStep = row.sent_count + 1;
        const openMinutes = Math.max(1, Math.round((now.getTime() - new Date(row.opened_at).getTime()) / 60_000));
        const title = `Escalation #${nextStep}: INC-${row.incident_number} ${row.incident_title} (unacknowledged for ${openMinutes} min)`;
        const details = {
          incident_id: row.incident_id,
          incident_number: row.incident_number,
          escalation_policy_id: row.policy_id,
          escalation_policy: row.policy_name,
          target_channel: row.channel_name,
          step: nextStep,
          unacknowledged_minutes: openMinutes,
        };
        const ev = await db.query<{ id: string }>(
          `INSERT INTO network_events (organization_id, site_id, device_id, check_id, type, severity, title, details, source, occurred_at)
           VALUES ($1,$2,$3,$4,'incident_escalated',$5,$6,$7,'platform',$8)
           RETURNING id`,
          [row.organization_id, row.site_id, row.device_id, row.check_id, row.incident_severity, title, JSON.stringify(details), now],
        );
        await db.query(
          // An escalation the owner configured is sent as is: the calm-alert policy does not hold it.
          `INSERT INTO notification_deliveries (organization_id, channel_id, event_id, policy_at)
           VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING`,
          [row.organization_id, row.channel_id, ev.rows[0]!.id],
        );
        await db.query(
          `INSERT INTO incident_escalations (policy_id, incident_id, organization_id, sent_count, last_sent_at)
           VALUES ($1,$2,$3,1,$4)
           ON CONFLICT (policy_id, incident_id) DO UPDATE SET sent_count = incident_escalations.sent_count + 1, last_sent_at = $4`,
          [row.policy_id, row.incident_id, row.organization_id, now],
        );
        await auditSystem(db, row.organization_id, {
          automation: 'notification_escalation',
          action: 'incident.escalated',
          target: { type: 'incident', id: row.incident_id },
          siteId: row.site_id,
          metadata: details,
        });
        await db.query('RELEASE SAVEPOINT escalation_row');
        touchedOrgs.add(row.organization_id);
        escalated++;
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT escalation_row');
        logger.warn({ err, policy_id: row.policy_id, incident_id: row.incident_id }, 'incident escalation failed');
      }
    }
    for (const orgId of touchedOrgs) await notifyRealtime(db, orgId, 'events');
  });
  return escalated;
}
