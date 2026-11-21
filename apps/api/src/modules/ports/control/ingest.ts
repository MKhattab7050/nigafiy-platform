import type { Db } from '../../../infrastructure/db.ts';
import { type CollectorContext, ItemRejected, type SwitchPortResultItem, type SwitchVlansItem } from '../../../common/collector-protocol.ts';
import { emitEvent } from '../../events/index.ts';
import { notifyRealtime } from '../../realtime/index.ts';

// Collector telemetry for port control: the VLAN picture of a switch, and the outcome of a port change.

/** Replaces the switch's VLANs and per-port VLAN membership with what the collector just read. */
async function applySwitchVlans(db: Db, c: CollectorContext, item: SwitchVlansItem): Promise<void> {
  const at = new Date(item.ts);
  const t = (
    await db.query<{ id: string; vlans_read_at: Date | null }>(`SELECT id, vlans_read_at FROM snmp_targets WHERE id = $1 AND site_id = $2 FOR UPDATE`, [item.target_id, c.siteId])
  ).rows[0];
  if (!t) throw new ItemRejected('switch_vlans for a switch that is not configured for this collector’s site');
  if (t.vlans_read_at && t.vlans_read_at > at) return; // an older read arriving late (spooled) never overwrites a newer one

  const vlans = [...new Map(item.vlans.map((v) => [v.id, v])).values()];
  const ports = [...new Map(item.ports.map((p) => [p.if_index, p])).values()];
  await db.query(`DELETE FROM switch_vlans WHERE target_id = $1`, [t.id]);
  if (vlans.length) {
    await db.query(
      `INSERT INTO switch_vlans (target_id, vlan_id, organization_id, name, source, updated_at)
       SELECT $1, v.id, $2, v.name, v.source, $3 FROM unnest($4::int[], $5::text[], $6::text[]) AS v(id, name, source)`,
      [t.id, c.organizationId, at, vlans.map((v) => v.id), vlans.map((v) => v.name ?? null), vlans.map((v) => v.source)],
    );
  }
  await db.query(`DELETE FROM switch_port_vlans WHERE target_id = $1`, [t.id]);
  if (ports.length) {
    await db.query(
      `INSERT INTO switch_port_vlans (target_id, if_index, organization_id, access_vlan, mode, source, updated_at)
       SELECT $1, p.if_index, $2, p.access_vlan, p.mode, p.source, $3 FROM unnest($4::int[], $5::int[], $6::text[], $7::text[]) AS p(if_index, access_vlan, mode, source)`,
      [t.id, c.organizationId, at, ports.map((p) => p.if_index), ports.map((p) => p.access_vlan ?? null), ports.map((p) => p.mode), ports.map((p) => p.source)],
    );
  }
  await db.query(`UPDATE snmp_targets SET sys_object_id = coalesce($2, sys_object_id), vlan_methods = $3, vlans_read_at = $4 WHERE id = $1`, [
    t.id,
    item.sys_object_id ?? null,
    [...new Set(item.methods)],
    at,
  ]);
}

interface RequestRow {
  id: string;
  site_id: string;
  target_id: string;
  collector_id: string | null;
  if_index: number;
  port_name: string;
  op: string;
  params: { admin_up?: boolean; alias?: string; vlan?: number };
  status: string;
  purpose: 'manual' | 'quarantine' | 'release';
  quarantine_id: string | null;
  created_by_email: string | null;
  switch_name: string;
  device_id: string | null;
}

/** Records the observed outcome of one `set_switch_port` command. */
async function applyPortResult(db: Db, c: CollectorContext, item: SwitchPortResultItem): Promise<void> {
  const r = (
    await db.query<RequestRow>(
      `SELECT q.id, q.site_id, q.target_id, q.collector_id, q.if_index, q.port_name, q.op, q.params, q.status, q.purpose, q.quarantine_id, q.created_by_email,
              coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, dq.device_id
         FROM switch_port_requests q
         JOIN snmp_targets t ON t.id = q.target_id
         LEFT JOIN device_quarantines dq ON dq.id = q.quarantine_id
        WHERE q.id = $1 FOR UPDATE OF q`,
      [item.request_id],
    )
  ).rows[0];
  // Only the collector the change was sent to can report it, and only for that switch and port.
  if (!r || r.site_id !== c.siteId || (r.collector_id && r.collector_id !== c.id) || r.target_id !== item.target_id || (item.if_index !== 0 && item.if_index !== r.if_index)) {
    throw new ItemRejected('switch_port_result for a change this collector was not asked to make');
  }
  // A late result for a request that expired on the server is still the truth about the switch: record it.
  if (r.status !== 'pending' && r.status !== 'expired') return; // a replay: already recorded
  const at = new Date(item.ts);
  const verified = item.ok && item.verified;
  const result = {
    before: item.before ?? null,
    after: item.after ?? null,
    verified: item.verified,
    rolled_back: item.rolled_back ?? false,
    steps: item.steps ?? [],
    duration_ms: item.duration_ms ?? null,
    reported_at: at.toISOString(),
    late: r.status === 'expired',
  };
  await db.query(
    `UPDATE switch_port_requests SET status = $2, result = $3, method = coalesce($4, method), error = $5, error_kind = $6, completed_at = $7 WHERE id = $1`,
    [r.id, verified ? 'verified' : r.status === 'expired' ? 'expired' : 'failed', JSON.stringify(result), item.method ?? null, verified ? null : (item.error?.message ?? 'The change was not verified'), verified ? null : (item.error?.kind ?? 'readback_mismatch'), at],
  );

  // What the collector read back is the newest observation of the port: show it right away.
  const after = item.after ?? {};
  if (after.admin_up !== undefined) await db.query(`UPDATE switch_ports SET admin_up = $3 WHERE target_id = $1 AND if_index = $2`, [r.target_id, r.if_index, after.admin_up]);
  if (after.alias !== undefined) await db.query(`UPDATE switch_ports SET alias = nullif($3, '') WHERE target_id = $1 AND if_index = $2`, [r.target_id, r.if_index, after.alias]);
  if (after.vlan !== undefined && after.vlan >= 1) {
    await db.query(`UPDATE switch_port_vlans SET access_vlan = $3, updated_at = $4 WHERE target_id = $1 AND if_index = $2`, [r.target_id, r.if_index, after.vlan, at]);
  }

  if (r.quarantine_id) {
    if (r.purpose === 'quarantine') {
      if (verified) {
        // The original VLAN is what the collector read right before writing (observed), not the older cached value.
        const observedBefore = item.before?.vlan && item.before.vlan >= 1 ? item.before.vlan : null;
        await db.query(
          `UPDATE device_quarantines SET status = 'active', activated_at = $2, last_error = NULL, original_vlan = coalesce($3, original_vlan)
            WHERE id = $1 AND status IN ('requested','failed')
              AND NOT EXISTS (SELECT 1 FROM device_quarantines o WHERE o.device_id = device_quarantines.device_id AND o.id <> device_quarantines.id AND o.status IN ('requested','active','releasing'))`,
          [r.quarantine_id, at, observedBefore],
        );
      } else {
        await db.query(`UPDATE device_quarantines SET status = 'failed', last_error = $2 WHERE id = $1 AND status = 'requested'`, [r.quarantine_id, item.error?.message ?? 'not verified']);
      }
    } else if (r.purpose === 'release') {
      if (verified) {
        await db.query(`UPDATE device_quarantines SET status = 'released', released_at = $2, released_by_email = $3, last_error = NULL WHERE id = $1 AND status IN ('releasing','active')`, [
          r.quarantine_id,
          at,
          r.created_by_email,
        ]);
      } else {
        await db.query(`UPDATE device_quarantines SET status = 'active', last_error = $2 WHERE id = $1 AND status = 'releasing'`, [r.quarantine_id, item.error?.message ?? 'not verified']);
      }
    }
  }

  if (!verified && r.status === 'expired') return; // already reported as expired; the result is kept on the request

  const what =
    r.op === 'admin_status' ? (r.params.admin_up ? 'enabled' : 'disabled') : r.op === 'alias' ? 'description changed' : `moved to VLAN ${r.params.vlan}`;
  const label = r.purpose === 'quarantine' ? 'quarantine' : r.purpose === 'release' ? 'quarantine release' : 'change';
  await emitEvent(db, c.organizationId, {
    siteId: r.site_id,
    deviceId: r.device_id,
    collectorId: c.id,
    type: verified ? 'switch_port_changed' : 'switch_port_change_failed',
    severity: verified ? 'info' : 'warning',
    title: verified ? `Port ${r.port_name} on ${r.switch_name} ${what} (verified)` : `Port ${r.port_name} on ${r.switch_name}: ${label} not done`,
    details: {
      request_id: r.id,
      target_id: r.target_id,
      if_index: r.if_index,
      op: r.op,
      purpose: r.purpose,
      requested_by: r.created_by_email,
      before: item.before ?? null,
      after: item.after ?? null,
      error: item.error ?? null,
      rolled_back: item.rolled_back ?? false,
      note: 'Before and after are the values the collector read from the switch right before writing and right after.',
    },
    source: 'collector',
    occurredAt: at,
  });
}

/** Port control telemetry: `switch_vlans` and `switch_port_result`. */
export async function processPortControlItem(db: Db, c: CollectorContext, item: SwitchVlansItem | SwitchPortResultItem): Promise<void> {
  if (item.type === 'switch_vlans') await applySwitchVlans(db, c, item);
  else await applyPortResult(db, c, item);
  await notifyRealtime(db, c.organizationId, 'devices');
}
