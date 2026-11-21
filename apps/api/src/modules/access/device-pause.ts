import { notFound } from '../../common/http.ts';
import type { Db } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { siteAccess } from './repo.ts';

/**
 * Pause a device's internet through the DNS filter until `until`, or resume it (`until` = null),
 * inside the caller's tenant transaction. Same effect as POST /devices/:id/pause
 * (services/devices.ts pauseDevice); the caller audits, because it knows who acted.
 */
export async function setDeviceInternetPause(db: Db, organizationId: string, deviceId: string, until: Date | null): Promise<{ previous_until: Date | null }> {
  const row = (await db.query<{ internet_paused_until: Date | null }>(`SELECT internet_paused_until FROM devices WHERE id = $1 FOR UPDATE`, [deviceId])).rows[0];
  if (!row) throw notFound('Device');
  await db.query(`UPDATE devices SET internet_paused_until = $2 WHERE id = $1`, [deviceId, until]);
  await notifyRealtime(db, organizationId, 'devices');
  return { previous_until: row.internet_paused_until };
}

/** Is the DNS filter turned on for this site? A pause only takes effect for devices that use the filter. */
export async function dnsFilterEnabled(db: Db, siteId: string): Promise<boolean> {
  return (await siteAccess(db, siteId)).enabled;
}
