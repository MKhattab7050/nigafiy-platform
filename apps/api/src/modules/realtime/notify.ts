import type { Db } from '../../infrastructure/db.ts';

export const REALTIME_CHANNEL = 'ld_realtime';

export type RealtimeTopic = 'events' | 'devices' | 'checks' | 'collectors';

/** Tell connected dashboards of this organization that something changed (delivered on COMMIT). */
export async function notifyRealtime(db: Db, organizationId: string, topic: RealtimeTopic): Promise<void> {
  await db.query(`SELECT pg_notify($1, $2)`, [REALTIME_CHANNEL, JSON.stringify({ org: organizationId, topic })]);
}
