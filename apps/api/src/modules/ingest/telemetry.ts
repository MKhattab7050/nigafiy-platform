import { type CollectorContext, ItemRejected, type TelemetryBatch } from '../../common/collector-protocol.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { refineCollectorIncident } from '../correlation/index.ts';
import { syncIpamConflicts } from '../ipam/index.ts';
import { processPortControlItem, processSnmpPoll } from '../ports/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { processRouterResult } from '../routers/index.ts';
import { processConfigBackupItem } from '../configbackup/index.ts';
import { processSmartCheck } from '../security/index.ts';
import { processToolResult } from '../toolbox/index.ts';
import { processCheckResult } from './checks.ts';
import { processDiscoveryRun } from './discovery/process-run.ts';
import { processDnsStats } from './dns-stats.ts';

export interface TelemetryOutcome {
  duplicate: boolean;
  accepted: number;
  rejected: { index: number; reason: string }[];
}

/**
 * Applies one telemetry batch in a single tenant transaction.
 *
 *  - Idempotent: collectors deliver at-least-once; a replayed batch is acknowledged and ignored.
 *  - Items are applied oldest first, each inside its own savepoint. An item refused by its
 *    processor (ItemRejected) is rolled back and reported; the rest of the batch still applies.
 *  - Any other error aborts the whole batch (the transaction rolls back, the request fails, and the
 *    collector re-sends the batch later).
 */
export function applyTelemetryBatch(c: CollectorContext, batch: TelemetryBatch): Promise<TelemetryOutcome> {
  const now = new Date();

  return withTenant(c.organizationId, async (db) => {
    const ledger = await db.query(`INSERT INTO ingest_batches (collector_id, batch_id, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      c.id,
      batch.batch_id,
      c.organizationId,
    ]);
    if (ledger.rowCount === 0) return { duplicate: true, accepted: 0, rejected: [] as { index: number; reason: string }[] };

    const ordered = batch.items
      .map((item, index) => ({ item, index, at: Date.parse(item.type === 'discovery_run' ? item.finished_at : item.ts) }))
      .sort((a, b) => a.at - b.at);
    const rejected: { index: number; reason: string }[] = [];
    let accepted = 0;
    let touchedDevices = false;
    for (const { item, index } of ordered) {
      // Savepoint per item: one bad item cannot abort or poison the rest of the batch.
      await db.query('SAVEPOINT item');
      try {
        if (item.type === 'discovery_run') {
          await processDiscoveryRun(db, c, item, now);
          touchedDevices = true;
        } else if (item.type === 'dns_stats') {
          await processDnsStats(db, c, item);
        } else if (item.type === 'snmp_poll') {
          await processSnmpPoll(db, c, item);
        } else if (item.type === 'switch_vlans' || item.type === 'switch_port_result') {
          await processPortControlItem(db, c, item);
        } else if (item.type === 'tool_result') {
          await processToolResult(db, c, item);
        } else if (item.type === 'router_result') {
          await processRouterResult(db, c, item);
        } else if (item.type === 'config_backup_result' || item.type === 'config_backup_probe_result') {
          await processConfigBackupItem(db, c, item);
        } else if (item.type === 'smart_check') {
          await processSmartCheck(db, c, item, now);
        } else {
          await processCheckResult(db, c, item, now);
        }
        await db.query('RELEASE SAVEPOINT item');
        accepted++;
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT item');
        if (!(err instanceof ItemRejected)) throw err;
        rejected.push({ index, reason: err.message });
      }
    }
    if (touchedDevices) {
      await notifyRealtime(db, c.organizationId, 'devices');
      // Discovery changed who answers where: compare with the documented addresses.
      await syncIpamConflicts(db, c.organizationId, c.siteId, now, c.id);
    }
    if (accepted) await refineCollectorIncident(db, c.organizationId, c.id);
    return { duplicate: false, accepted, rejected };
  });
}
