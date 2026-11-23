import type { CheckRole, CheckState, Severity } from '@nigafiy/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { type CheckResultItem, type CollectorContext, ItemRejected, MAX_FUTURE_SKEW_MS } from '../../common/collector-protocol.ts';
import { emitEvent } from '../events/index.ts';
import { classifyValue } from '../monitoring/kinds.ts';
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
  config: Record<string, unknown>;
}

type SampleState = 'ok' | 'degraded' | 'down';
const RANK: Record<SampleState, number> = { ok: 0, degraded: 1, down: 2 };

/**
 * Deterministic, explainable classification of one sample. The reasons are stored with the event.
 * Watch checks (tls_expiry, snmp_oid) also classify their measured value against the check's
 * warning / critical thresholds (monitoring/kinds.ts); the worse of value and latency wins.
 */
export function classifySample(
  item: Pick<CheckResultItem, 'ok' | 'latency_ms' | 'loss_pct'> & { value?: number; error?: string },
  check: Pick<CheckRow, 'latency_warn_ms' | 'loss_warn_pct'> & { kind?: string; config?: Record<string, unknown> },
): { state: SampleState; reasons: string[] } {
  if (!item.ok) return { state: 'down', reasons: [item.error ? `The check failed: ${item.error}` : 'The check failed'] };
  const byValue = check.kind ? classifyValue(check.kind, check.config ?? {}, item.value) : null;
  if (byValue?.state === 'down') return byValue;
  const reasons: string[] = [...(byValue?.reasons ?? [])];
  if (check.latency_warn_ms !== null && item.latency_ms !== undefined && item.latency_ms > check.latency_warn_ms) {
    reasons.push(`Latency ${item.latency_ms.toFixed(1)} ms is above the ${check.latency_warn_ms} ms threshold`);
  }
  if (check.loss_warn_pct !== null && item.loss_pct !== undefined && item.loss_pct > check.loss_warn_pct) {
    reasons.push(`Packet loss ${item.loss_pct.toFixed(0)}% is above the ${check.loss_warn_pct}% threshold`);
  }
  const state: SampleState = reasons.length ? 'degraded' : 'ok';
  return { state: byValue && RANK[byValue.state] > RANK[state] ? byValue.state : state, reasons };
}

/** Event title for a state change; a measured threshold breach is not "not responding". */
function transitionTitle(name: string, kind: string, state: SampleState, sampleOk: boolean, value: number | undefined): string {
  if (state === 'ok') return `${name}: recovered`;
  if (kind === 'tls_expiry' && sampleOk && value !== undefined) {
    return value < 0 ? `${name}: certificate expired` : `${name}: certificate expires in ${Math.max(0, Math.floor(value))} days`;
  }
  if (state === 'down') return sampleOk ? `${name}: critical threshold crossed` : `${name}: not responding`;
  return sampleOk && kind === 'snmp_oid' ? `${name}: warning threshold crossed` : `${name}: degraded performance`;
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
    `SELECT id, name, kind, role, target, enabled, state, pending_state, pending_count, failure_threshold, latency_warn_ms, loss_warn_pct, last_result_at, config
       FROM monitoring_checks WHERE id = $1 AND site_id = $2 FOR UPDATE`,
    [item.check_id, c.siteId],
  );
  const check = found.rows[0];
  if (!check) throw new ItemRejected('check is unknown or not part of this collector\'s site');
  if (!check.enabled) return;

  const inserted = await db.query(
    `INSERT INTO check_results (check_id, ts, organization_id, ok, latency_ms, loss_pct, jitter_ms, error, value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [check.id, ts, c.organizationId, item.ok, item.latency_ms ?? null, item.loss_pct ?? null, item.jitter_ms ?? null, item.error ?? null, item.value ?? null],
  );
  if (inserted.rowCount === 0) return; // duplicate sample
  if (check.last_result_at && ts <= check.last_result_at) return; // late sample: history only, live state untouched

  const sample = classifySample(item, { ...check, config: check.config ?? {} });
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
            state_changed_at = CASE WHEN $10 THEN $5 ELSE state_changed_at END,
            last_value = $11, last_details = $12
      WHERE id = $1`,
    [
      check.id,
      state,
      pendingState,
      pendingCount,
      ts,
      item.latency_ms ?? null,
      item.loss_pct ?? null,
      item.ok ? null : (item.error ?? 'failed'),
      item.resolved_target ?? null,
      transitioned,
      item.value ?? null,
      item.details ? JSON.stringify(item.details) : null,
    ],
  );

  if (!transitioned) return;
  await notifyRealtime(db, c.organizationId, 'checks');
  // First ever sample that is healthy is not news.
  if (previous === 'unknown' && state === 'ok') return;

  const core = check.role !== 'service';
  const map: Record<SampleState, { type: string; severity: Severity }> = {
    down: { type: 'check_down', severity: core ? 'critical' : 'warning' },
    degraded: { type: 'check_degraded', severity: 'warning' },
    ok: { type: 'check_recovered', severity: 'info' },
  };
  const meta = { ...map[state as SampleState], title: transitionTitle(check.name, check.kind, state as SampleState, item.ok, item.value) };
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
      latest_sample: {
        ts,
        ok: item.ok,
        latency_ms: item.latency_ms ?? null,
        loss_pct: item.loss_pct ?? null,
        jitter_ms: item.jitter_ms ?? null,
        error: item.error ?? null,
        ...(item.value !== undefined ? { value: item.value } : {}),
        ...(item.details ? { details: item.details } : {}),
      },
      thresholds: { latency_warn_ms: check.latency_warn_ms, loss_warn_pct: check.loss_warn_pct, ...valueThresholds(check.kind, check.config) },
      measured_from: `collector "${c.name}"`,
    },
    source: 'collector',
    occurredAt: ts,
  });
}

/** The value thresholds of a watch check, copied into its state-change events as evidence. */
function valueThresholds(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'tls_expiry') return { warn_days: config.warn_days ?? null, critical_days: config.critical_days ?? null };
  if (kind === 'snmp_oid') return { oid: config.oid ?? null, comparison: config.comparison ?? null, warn: config.warn ?? null, critical: config.critical ?? null, unit: config.unit ?? '' };
  if (kind === 'http' || kind === 'https') return { expect_status: config.expect_status ?? null };
  return {};
}
