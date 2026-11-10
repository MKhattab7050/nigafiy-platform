import { withSystem } from '../infrastructure/db.ts';
import { emitEvent, notifyRealtime } from '../modules/events/emit.ts';

/** A collector heartbeats every 30 s; four missed heartbeats = lost contact. */
export const COLLECTOR_OFFLINE_AFTER_SECONDS = 120;

/**
 * Detect collectors that stopped reporting.
 *
 * Important honesty rule: when the only observer of a site goes silent we do NOT know whether the
 * devices there are up or down, so their status becomes `unknown` — never `offline`.
 */
export async function watchCollectors(): Promise<void> {
  await withSystem(async (db) => {
    const gone = await db.query<{ id: string; organization_id: string; site_id: string; name: string; last_heartbeat_at: Date }>(
      `UPDATE collectors SET connection_state = 'offline'
        WHERE status = 'active' AND connection_state = 'online'
          AND last_heartbeat_at < now() - make_interval(secs => $1)
        RETURNING id, organization_id, site_id, name, last_heartbeat_at`,
      [COLLECTOR_OFFLINE_AFTER_SECONDS],
    );
    for (const c of gone.rows) {
      const stillObserved = await db.query(
        `SELECT 1 FROM collectors WHERE organization_id = $1 AND site_id = $2 AND status = 'active' AND connection_state = 'online' LIMIT 1`,
        [c.organization_id, c.site_id],
      );
      let devicesAffected = 0;
      if (!stillObserved.rowCount) {
        const now = new Date();
        const affected = await db.query<{ id: string }>(
          `UPDATE devices SET status = 'unknown' WHERE organization_id = $1 AND site_id = $2 AND status = 'online' RETURNING id`,
          [c.organization_id, c.site_id],
        );
        const ids = affected.rows.map((r) => r.id);
        devicesAffected = ids.length;
        if (ids.length) {
          await db.query(`UPDATE availability_history SET ended_at = $2 WHERE organization_id = $3 AND device_id = ANY($1) AND ended_at IS NULL`, [ids, now, c.organization_id]);
          await db.query(
            `INSERT INTO availability_history (organization_id, device_id, status, started_at) SELECT $1, unnest($2::uuid[]), 'unknown', $3`,
            [c.organization_id, ids, now],
          );
        }
      }
      await emitEvent(db, c.organization_id, {
        siteId: c.site_id,
        collectorId: c.id,
        type: 'collector_offline',
        severity: 'critical',
        title: `Collector "${c.name}" lost contact with the cloud`,
        details: {
          last_heartbeat_at: c.last_heartbeat_at,
          rule: `No heartbeat for more than ${COLLECTOR_OFFLINE_AFTER_SECONDS} seconds`,
          devices_now_unknown: devicesAffected,
          possible_causes: ['The site lost its internet connection', 'The collector host is powered off or restarting', 'The collector service stopped', 'Outbound HTTPS from the collector is blocked'],
          note: 'From the cloud these causes are indistinguishable. The collector keeps monitoring locally and uploads buffered results when it reconnects.',
        },
        source: 'platform',
        occurredAt: new Date(),
      });
      await notifyRealtime(db, c.organization_id, 'collectors');
      await notifyRealtime(db, c.organization_id, 'devices');
    }

    const goneEndpoints = await db.query<{ id: string; organization_id: string }>(
      `UPDATE endpoints SET connection_state = 'offline'
        WHERE status = 'active' AND connection_state = 'online'
          AND last_heartbeat_at < now() - make_interval(secs => $1)
        RETURNING id, organization_id`,
      [COLLECTOR_OFFLINE_AFTER_SECONDS],
    );
    for (const ep of goneEndpoints.rows) {
      await notifyRealtime(db, ep.organization_id, 'devices');
    }
  });
}
