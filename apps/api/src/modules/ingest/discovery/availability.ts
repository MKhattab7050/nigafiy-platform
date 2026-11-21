import type { DeviceStatus } from '@lan-detective/shared-types';
import type { Db } from '../../../infrastructure/db.ts';

/** Close the devices' open availability intervals and open new ones with `status` at `at`. */
export async function setAvailability(db: Db, organizationId: string, deviceIds: string[], status: DeviceStatus, at: Date): Promise<void> {
  if (deviceIds.length === 0) return;
  await db.query(`UPDATE availability_history SET ended_at = $2 WHERE device_id = ANY($1) AND ended_at IS NULL`, [deviceIds, at]);
  await db.query(
    `INSERT INTO availability_history (organization_id, device_id, status, started_at) SELECT $1, unnest($2::uuid[]), $3, $4`,
    [organizationId, deviceIds, status, at],
  );
}
