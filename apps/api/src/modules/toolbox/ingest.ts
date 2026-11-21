import { type CollectorContext, ItemRejected, type ToolResultItem } from '../../common/collector-protocol.ts';
import type { Db } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';

/** Applies a tool_result telemetry item from the collector that was asked to run the tool. */
export async function processToolResult(db: Db, c: CollectorContext, item: ToolResultItem): Promise<void> {
  const status = item.ok ? 'completed' : 'failed';
  const output = item.ok && item.output ? JSON.stringify(item.output) : null;
  const error = item.ok ? null : (item.error ?? 'The tool could not complete');
  const updated = await db.query(
    `UPDATE toolbox_runs
        SET status = $3,
            output = $4,
            error = $5,
            duration_ms = $6,
            completed_at = $7
      WHERE id = $1 AND collector_id = $2 AND status = 'pending'`,
    [item.run_id, c.id, status, output, error, item.duration_ms ?? null, new Date(item.ts)],
  );
  if (!updated.rowCount) {
    throw new ItemRejected('Toolbox run does not belong to this collector or is no longer pending');
  }
  await notifyRealtime(db, c.organizationId, 'checks');
}
