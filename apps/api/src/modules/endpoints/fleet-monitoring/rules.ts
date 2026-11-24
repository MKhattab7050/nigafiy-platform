import type { Request } from 'express';
import type { FleetMonitorRule, FleetMonitorState } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import { recoverRuleAlerts } from './evaluate.ts';
import type { MonitorRuleInput } from './schema.ts';

// Monitoring rules for managed computers (Fleet Pro, migration 043). Admins create, change and
// delete them; technicians and viewers read them and the current breaches. Every change is audited.

const RULE_COLUMNS = `r.id, r.fleet_group_id, g.name AS fleet_group_name, r.name, r.kind, r.threshold::float8 AS threshold, r.threshold_unit,
  r.mount, r.service_name, r.event_log, r.event_source, r.event_ids, r.event_level, r.match_text, r.event_window_minutes,
  r.duration_seconds, r.severity, r.enabled, r.created_by_email, r.updated_at,
  (SELECT count(*)::int FROM fleet_monitor_states s WHERE s.rule_id = r.id AND s.breached_since IS NOT NULL) AS breaching,
  (SELECT count(*)::int FROM fleet_monitor_states s WHERE s.rule_id = r.id AND s.alerted_at IS NOT NULL) AS alerting`;

export async function listRules(ctx: AuthContext): Promise<FleetMonitorRule[]> {
  return withTenant(ctx.organizationId, async (db) =>
    (await db.query<FleetMonitorRule>(`SELECT ${RULE_COLUMNS} FROM fleet_monitor_rules r LEFT JOIN fleet_groups g ON g.id = r.fleet_group_id ORDER BY r.name, r.created_at`)).rows,
  );
}

async function ruleById(db: Db, id: string): Promise<FleetMonitorRule> {
  const r = (await db.query<FleetMonitorRule>(`SELECT ${RULE_COLUMNS} FROM fleet_monitor_rules r LEFT JOIN fleet_groups g ON g.id = r.fleet_group_id WHERE r.id = $1`, [id])).rows[0];
  if (!r) throw notFound('Monitoring rule');
  return r;
}

async function checkGroup(db: Db, groupId: string | null): Promise<void> {
  if (!groupId) return;
  const g = await db.query(`SELECT 1 FROM fleet_groups WHERE id = $1`, [groupId]);
  if (!g.rows[0]) throw new AppError(400, 'unknown_group', 'That Fleet group does not exist');
}

const auditFields = (b: MonitorRuleInput) => ({ ...b });

export async function createRule(req: Request, ctx: AuthContext, b: MonitorRuleInput): Promise<FleetMonitorRule> {
  return withTenant(ctx.organizationId, async (db) => {
    await checkGroup(db, b.fleet_group_id);
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO fleet_monitor_rules (organization_id, fleet_group_id, name, kind, threshold, threshold_unit, mount, service_name, event_log, event_source,
                                          event_ids, event_level, match_text, event_window_minutes, duration_seconds, severity, enabled, created_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [
          ctx.organizationId,
          b.fleet_group_id,
          b.name,
          b.kind,
          b.threshold,
          b.threshold_unit,
          b.mount,
          b.service_name,
          b.event_log,
          b.event_source,
          b.event_ids,
          b.event_level,
          b.match_text,
          b.event_window_minutes,
          b.duration_seconds,
          b.severity,
          b.enabled,
          ctx.userEmail,
        ],
      )
    ).rows[0]!.id;
    await audit(db, req, 'fleet.monitor_rule_created', { type: 'fleet_monitor_rule', id }, auditFields(b));
    return ruleById(db, id);
  });
}

export async function updateRule(req: Request, ctx: AuthContext, id: string, b: MonitorRuleInput): Promise<FleetMonitorRule> {
  return withTenant(ctx.organizationId, async (db) => {
    const before = await ruleById(db, id);
    await checkGroup(db, b.fleet_group_id);
    await db.query(
      `UPDATE fleet_monitor_rules
          SET fleet_group_id = $2, name = $3, kind = $4, threshold = $5, threshold_unit = $6, mount = $7, service_name = $8, event_log = $9, event_source = $10,
              event_ids = $11, event_level = $12, match_text = $13, event_window_minutes = $14, duration_seconds = $15, severity = $16, enabled = $17, updated_at = now()
        WHERE id = $1`,
      [id, b.fleet_group_id, b.name, b.kind, b.threshold, b.threshold_unit, b.mount, b.service_name, b.event_log, b.event_source, b.event_ids, b.event_level, b.match_text, b.event_window_minutes, b.duration_seconds, b.severity, b.enabled],
    );
    // A changed rule starts over: open alerts are resolved ("the rule changed"), measurements restart.
    await recoverRuleAlerts(db, ctx.organizationId, id, b.enabled ? 'the rule was changed' : 'the rule was turned off');
    await audit(db, req, 'fleet.monitor_rule_updated', { type: 'fleet_monitor_rule', id }, { before: { name: before.name, kind: before.kind, enabled: before.enabled }, after: auditFields(b) });
    return ruleById(db, id);
  });
}

export async function deleteRule(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const before = await ruleById(db, id);
    await recoverRuleAlerts(db, ctx.organizationId, id, 'the rule was deleted');
    await db.query(`DELETE FROM fleet_monitor_rules WHERE id = $1`, [id]);
    await audit(db, req, 'fleet.monitor_rule_deleted', { type: 'fleet_monitor_rule', id }, { name: before.name, kind: before.kind });
  });
}

export async function listStates(ctx: AuthContext, q: { breaching?: '1' | '0'; endpoint_id?: string }): Promise<FleetMonitorState[]> {
  return withTenant(ctx.organizationId, async (db) =>
    (
      await db.query<FleetMonitorState>(
        `SELECT s.rule_id, r.name AS rule_name, r.kind, r.severity, s.endpoint_id, e.name AS endpoint_name, s.breached_since, s.alerted_at, s.last_value, s.last_checked_at
           FROM fleet_monitor_states s
           JOIN fleet_monitor_rules r ON r.id = s.rule_id
           JOIN endpoints e ON e.id = s.endpoint_id
          WHERE ($1::boolean IS NULL OR (s.breached_since IS NOT NULL) = $1::boolean)
            AND ($2::uuid IS NULL OR s.endpoint_id = $2::uuid)
          ORDER BY s.alerted_at DESC NULLS LAST, s.breached_since DESC NULLS LAST, e.name
          LIMIT 500`,
        [q.breaching === undefined ? null : q.breaching === '1', q.endpoint_id ?? null],
      )
    ).rows,
  );
}
