import type { CheckRole, CheckState, Severity } from '@lan-detective/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { type CheckResultItem, type CollectorContext, ItemRejected, MAX_FUTURE_SKEW_MS } from '../../common/collector-protocol.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';

interface CheckRow {
  id: string;
  name: string;
  kind: string;
  role: CheckRole;
  target: string;
  enabled: boolean;
  state: CheckState;
  pending_state: CheckState | null;
  pending_count: number;
  failure_threshold: number;
  latency_warn_ms: number | null;
  loss_warn_pct: number | null;
  last_result_at: Date | null;
}

type SampleState = 'ok' | 'degraded' | 'down';

/** Deterministic, explainable classification of one sample. The reasons are stored with the event. */
export function classifySample(item: Pick<CheckResultItem, 'ok' | 'latency_ms' | 'loss_pct'>, check: Pick<CheckRow, 'latency_warn_ms' | 'loss_warn_pct'>): { state: SampleState; reasons: string[] } {
  if (!item.ok) return { state: 'down', reasons: ['The check failed'] };
  const reasons: string[] = [];
  if (check.latency_warn_ms !== null && item.latency_ms !== undefined && item.latency_ms > check.latency_warn_ms) {
    reasons.push(`Latency ${item.latency_ms.toFixed(1)} ms is above the ${check.latency_warn_ms} ms threshold`);
  }
  if (check.loss_warn_pct !== null && item.loss_pct !== undefined && item.loss_pct > check.loss_warn_pct) {
    reasons.push(`Packet loss ${item.loss_pct.toFixed(0)}% is above the ${check.loss_warn_pct}% threshold`);
  }
  return { state: reasons.length ? 'degraded' : 'ok', reasons };
}

/**
 * Store one check sample and advance the check's state machine.
 * A state only changes after `failure_threshold` consecutive samples agree (alert de-duplication /
 * flap damping), and exactly one event is emitted per transition.
 */
export async function processCheckResult(db: Db, c: CollectorContext, item: CheckResultItem, now: Date): Promise<void> {
  const ts = new Date(item.ts);
  if (ts.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) throw new ItemRejected('timestamp is in the future');

  const found = await db.query<CheckRow>(
    `SELECT id, name, kind, role, target, enabled, state, pending_state, pending_count, failure_threshold, latency_warn_ms, loss_warn_pct, last_result_at
       FROM monitoring_checks WHERE id = $1 AND site_id = $2 FOR UPDATE`,
    [item.check_id, c.siteId],
  );
  const check = found.rows[0];
  if (!check) throw new ItemRejected('check is unknown or not part of this collector\'s site');
  if (!check.enabled) return;

  const inserted = await db.query(
    `INSERT INTO check_results (check_id, ts, organization_id, ok, latency_ms, loss_pct, jitter_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [check.id, ts, c.organizationId, item.ok, item.latency_ms ?? null, item.loss_pct ?? null, item.jitter_ms ?? null, item.error ?? null],
  );
  if (inserted.rowCount === 0) return; // duplicate sample
  if (check.last_result_at && ts <= check.last_result_at) return; // late sample: history only, live state untouched

  const sample = classifySample(item, check);
  let { state, pending_state: pendingState, pending_count: pendingCount } = check;
  const previous = state;
  let transitioned = false;
  if (sample.state === state) {
    pendingState = null;
    pendingCount = 0;
  } else {
    pendingCount = pendingState === sample.state ? pendingCount + 1 : 1;
    pendingState = sample.state;
    const needed = state === 'unknown' ? 1 : check.failure_threshold;
    if (pendingCount >= needed) {
      state = sample.state;
      pendingState = null;
      pendingCount = 0;
      transitioned = true;
    }
  }

  await db.query(
    `UPDATE monitoring_checks
        SET state = $2, pending_state = $3, pending_count = $4, last_result_at = $5, last_latency_ms = $6, last_loss_pct = $7,
            last_error = $8, last_resolved_target = coalesce($9, last_resolved_target),
            state_changed_at = CASE WHEN $10 THEN $5 ELSE state_changed_at END
      WHERE id = $1`,
    [check.id, state, pendingState, pendingCount, ts, item.latency_ms ?? null, item.loss_pct ?? null, item.ok ? null : (item.error ?? 'failed'), item.resolved_target ?? null, transitioned],
  );

  if (!transitioned) return;
  await notifyRealtime(db, c.organizationId, 'checks');
  // First ever sample that is healthy is not news.
  if (previous === 'unknown' && state === 'ok') return;

  const core = check.role !== 'service';
  const map: Record<SampleState, { type: string; severity: Severity; title: string }> = {
    down: { type: 'check_down', severity: core ? 'critical' : 'warning', title: `${check.name}: not responding` },
    degraded: { type: 'check_degraded', severity: 'warning', title: `${check.name}: degraded performance` },
    ok: { type: 'check_recovered', severity: 'info', title: `${check.name}: recovered` },
  };
  const meta = map[state as SampleState];
  await emitEvent(db, c.organizationId, {
    siteId: c.siteId,
    checkId: check.id,
    collectorId: c.id,
    type: meta.type,
    severity: meta.severity,
    title: meta.title,
    details: {
      check: { kind: check.kind, role: check.role, target: check.target, resolved_target: item.resolved_target ?? null },
      previous_state: previous,
      new_state: state,
      rule: previous === 'unknown' ? 'First sample for this check' : `${check.failure_threshold} consecutive samples classified "${state}"`,
      reasons: sample.reasons,
      latest_sample: { ts, ok: item.ok, latency_ms: item.latency_ms ?? null, loss_pct: item.loss_pct ?? null, jitter_ms: item.jitter_ms ?? null, error: item.error ?? null },
      thresholds: { latency_warn_ms: check.latency_warn_ms, loss_warn_pct: check.loss_warn_pct },
      measured_from: `collector "${c.name}"`,
    },
    source: 'collector',
    occurredAt: ts,
  });
}
