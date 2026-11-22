import type { CollectorContext } from '../../../common/collector-protocol.ts';
import { cidrContains } from '../../../common/net.ts';
import type { Db } from '../../../infrastructure/db.ts';
import { emitEvent } from '../../events/index.ts';
import { setAvailability } from './availability.ts';
import { type DeviceRow, deviceLabel } from './identities.ts';

/** A device is declared offline only after it was absent from this many consecutive sweeps of its scope. */
export const OFFLINE_AFTER_MISSED_SWEEPS = 2;

/**
 * Devices of the scope that did not answer this sweep: count the miss, and after
 * OFFLINE_AFTER_MISSED_SWEEPS consecutive misses mark them offline and raise `device_offline`.
 */
export async function markMissingDevices(
  db: Db,
  c: CollectorContext,
  scope: { cidr: string },
  loaded: DeviceRow[],
  claimed: Set<string>,
  finishedAt: Date,
): Promise<void> {
  const missing = loaded.filter((d) => !claimed.has(d.id) && d.status !== 'offline' && d.ip && cidrContains(scope.cidr, d.ip));
  if (!missing.length) return;
  const counted = await db.query<{ id: string; missed_sweeps: number }>(
    `UPDATE devices SET missed_sweeps = missed_sweeps + 1 WHERE id = ANY($1) RETURNING id, missed_sweeps`,
    [missing.map((d) => d.id)],
  );
  const missedById = new Map(counted.rows.map((r) => [r.id, r.missed_sweeps]));
  const goneOffline = missing.filter((d) => (missedById.get(d.id) ?? 0) >= OFFLINE_AFTER_MISSED_SWEEPS);
  if (!goneOffline.length) return;
  const ids = goneOffline.map((d) => d.id);
  await db.query(`UPDATE devices SET status = 'offline' WHERE id = ANY($1)`, [ids]);
  await setAvailability(db, c.organizationId, ids, 'offline', finishedAt);
  for (const d of goneOffline) {
    if (d.alerts_muted) continue; // muted: availability is still recorded, no alert
    await emitEvent(db, c.organizationId, {
      siteId: c.siteId,
      deviceId: d.id,
      collectorId: c.id,
      type: 'device_offline',
      // Laptops and phones leave all day; only devices marked critical raise a critical alert.
      severity: d.is_critical ? 'critical' : 'info',
      title: `${deviceLabel(d)} stopped responding`,
      details: {
        ip: d.ip,
        mac: d.mac,
        last_seen_at: d.last_seen_at,
        consecutive_missed_sweeps: missedById.get(d.id),
        scope: scope.cidr,
        method: scope.cidr.includes(':')
          ? 'No ICMPv6 echo reply (to ff02::1 or unicast) and no reachable IPv6 neighbour-table entry on the collector host'
          : 'No ICMP echo reply and no neighbour (ARP) table entry on the collector host',
        limitation: 'A device that is powered on but silent to both ICMP and ARP from the collector would also look like this.',
      },
      source: 'collector',
      occurredAt: finishedAt,
    });
  }
}
