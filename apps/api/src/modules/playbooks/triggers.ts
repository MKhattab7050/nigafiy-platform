import { type Db, systemPool, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { ACTIONS, type ActionKey, LIMITS } from './catalog.ts';
import { advanceRun, createRun } from './engine.ts';
import { ACTIVE_RUN_STATUSES, PLAYBOOK_SELECT, type PlaybookRow } from './repo.ts';
import { dueScheduleSlot } from './schedule.ts';
import type { EventTrigger, IncidentTrigger, ScheduleTrigger } from './schema.ts';

// Trigger matching: which enabled playbooks should start now. Idempotent by construction — every
// run carries a trigger key (event:<id>, incident:<on>:<id>, schedule:<slot>) that is UNIQUE per
// playbook, so a second pass (or a second API instance) can never start the same run twice.

const MATCHES_PER_PASS = 25;

/** Earliest moment a trigger may match: not before the playbook was enabled, and not older than the lookback. */
function notBefore(p: PlaybookRow, now: Date): Date {
  const lookback = new Date(now.getTime() - LIMITS.triggerLookbackMinutes * 60_000);
  const enabled = p.enabled_at ? new Date(p.enabled_at) : now;
  return enabled.getTime() > lookback.getTime() ? enabled : lookback;
}

/** max_runs_per_hour: automatic runs (not manual, not skipped) in the last hour. */
async function overRateLimit(db: Db, p: PlaybookRow): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM playbook_runs WHERE playbook_id = $1 AND trigger_kind <> 'manual' AND status <> 'skipped' AND created_at > now() - interval '1 hour'`,
    [p.id],
  );
  return (r.rows[0]?.n ?? 0) >= p.max_runs_per_hour;
}

const rateLimitReason = (p: PlaybookRow) => `Not started: the playbook already ran ${p.max_runs_per_hour} time(s) in the last hour (its limit)`;

interface EventRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  details: Record<string, unknown>;
  site_id: string | null;
  device_id: string | null;
  check_id: string | null;
  occurred_at: Date;
  incident_id: string | null;
}

/**
 * Loop guard. If a recent step of a playbook run can have caused this event (same device, or the
 * same site for site-wide actions), the new run joins that run's chain. A playbook already in the
 * chain, or a chain at its maximum depth, is not started again.
 */
async function loopGuard(db: Db, p: PlaybookRow, ev: EventRow): Promise<{ causedBy: string | null; chain: string[]; skip: string | null }> {
  const actions = (Object.keys(ACTIONS) as ActionKey[]).filter((a) => ACTIONS[a].produces.includes(ev.type));
  if (!actions.length) return { causedBy: null, chain: [], skip: null };
  const siteWide = actions.filter((a) => ACTIONS[a].siteWide);
  const cause = (
    await db.query<{ id: string; playbook_id: string | null; chain: string[] }>(
      `SELECT r.id, r.playbook_id, r.chain
         FROM playbook_run_steps s JOIN playbook_runs r ON r.id = s.run_id
        WHERE s.action = ANY($1) AND s.started_at > now() - make_interval(mins => $2) AND s.status IN ('running', 'succeeded')
          AND NOT r.dry_run
          AND ( ($3::uuid IS NOT NULL AND s.input ->> 'device_id' = $3::text)
             OR (s.action = ANY($4) AND (r.site_id IS NULL OR r.site_id = $5)) )
        ORDER BY s.started_at DESC LIMIT 1`,
      [actions, LIMITS.loopWindowMinutes, ev.device_id, siteWide, ev.site_id],
    )
  ).rows[0];
  if (!cause) return { causedBy: null, chain: [], skip: null };
  const chain = [...(cause.chain ?? []), ...(cause.playbook_id ? [cause.playbook_id] : [])];
  if (chain.includes(p.id)) return { causedBy: cause.id, chain, skip: 'Not started: this event was caused by an action of this same playbook (loop guard)' };
  if (chain.length >= LIMITS.maxChainDepth) return { causedBy: cause.id, chain, skip: `Not started: ${chain.length} playbooks already triggered each other in a chain (loop guard)` };
  return { causedBy: cause.id, chain, skip: null };
}

async function matchEvents(db: Db, p: PlaybookRow, t: EventTrigger, now: Date): Promise<string[]> {
  const f = t.filters ?? {};
  const events = (
    await db.query<EventRow>(
      `SELECT e.id, e.type, e.severity, e.title, e.details, e.site_id, e.device_id, e.check_id, e.occurred_at,
              (SELECT ie.incident_id FROM incident_events ie WHERE ie.event_id = e.id LIMIT 1) AS incident_id
         FROM network_events e
         LEFT JOIN devices d ON d.id = e.device_id
         LEFT JOIN monitoring_checks c ON c.id = e.check_id
        WHERE e.type = ANY($1) AND e.received_at > $2 AND NOT e.in_maintenance
          AND ($3::uuid IS NULL OR e.site_id = $3)
          AND ($4::text[] IS NULL OR e.severity = ANY($4))
          AND ($5::text[] IS NULL OR d.trust = ANY($5))
          AND ($6::text[] IS NULL OR d.device_type = ANY($6))
          AND (NOT $7::boolean OR coalesce(d.is_critical, false))
          AND ($8::uuid[] IS NULL OR e.check_id = ANY($8))
          AND ($9::text[] IS NULL OR c.role = ANY($9))
          AND NOT EXISTS (SELECT 1 FROM playbook_runs r WHERE r.playbook_id = $10 AND r.trigger_key = 'event:' || e.id::text)
        ORDER BY e.received_at, e.id
        LIMIT $11`,
      [
        t.event_types,
        notBefore(p, now),
        p.site_id,
        f.severities?.length ? f.severities : null,
        f.device_trust?.length ? f.device_trust : null,
        f.device_types?.length ? f.device_types : null,
        Boolean(f.critical_only),
        f.check_ids?.length ? f.check_ids : null,
        f.check_roles?.length ? f.check_roles : null,
        p.id,
        MATCHES_PER_PASS,
      ],
    )
  ).rows;
  const created: string[] = [];
  for (const ev of events) {
    const guard = await loopGuard(db, p, ev);
    const skip = guard.skip ?? ((await overRateLimit(db, p)) ? rateLimitReason(p) : null);
    const id = await createRun(db, p, {
      kind: 'event',
      key: `event:${ev.id}`,
      evidence: { event_id: ev.id, type: ev.type, severity: ev.severity, title: ev.title, details: ev.details, check_id: ev.check_id, occurred_at: new Date(ev.occurred_at).toISOString() },
      siteId: ev.site_id,
      deviceId: ev.device_id,
      incidentId: ev.incident_id,
      eventId: ev.id,
      causedByRunId: guard.causedBy,
      chain: guard.chain,
      dryRun: p.dry_run,
      skipReason: skip,
    });
    if (id && !skip) created.push(id);
  }
  return created;
}

async function matchIncidents(db: Db, p: PlaybookRow, t: IncidentTrigger, now: Date): Promise<string[]> {
  const incidents = (
    await db.query<{ id: string; number: number; kind: string; severity: string; title: string; site_id: string | null; device_id: string | null; check_id: string | null; status: string }>(
      `SELECT i.id, i.number, i.kind, i.severity, i.title, i.site_id, i.device_id, i.check_id, i.status
         FROM incidents i
        WHERE (CASE WHEN $1 = 'opened' THEN i.created_at ELSE i.resolved_at END) > $2
          AND ($3::uuid IS NULL OR i.site_id = $3)
          AND ($4::text[] IS NULL OR i.kind = ANY($4))
          AND ($5::text[] IS NULL OR i.severity = ANY($5))
          AND NOT EXISTS (SELECT 1 FROM playbook_runs r WHERE r.playbook_id = $6 AND r.trigger_key = 'incident:' || $1 || ':' || i.id::text)
        ORDER BY i.created_at, i.id
        LIMIT $7`,
      [t.on, notBefore(p, now), p.site_id, t.incident_kinds?.length ? t.incident_kinds : null, t.severities?.length ? t.severities : null, p.id, MATCHES_PER_PASS],
    )
  ).rows;
  const created: string[] = [];
  for (const i of incidents) {
    const skip = (await overRateLimit(db, p)) ? rateLimitReason(p) : null;
    const id = await createRun(db, p, {
      kind: 'incident',
      key: `incident:${t.on}:${i.id}`,
      evidence: { incident_id: i.id, number: i.number, on: t.on, kind: i.kind, severity: i.severity, title: i.title, status: i.status, check_id: i.check_id },
      siteId: i.site_id,
      deviceId: i.device_id,
      incidentId: i.id,
      eventId: null,
      dryRun: p.dry_run,
      skipReason: skip,
    });
    if (id && !skip) created.push(id);
  }
  return created;
}

async function matchSchedule(db: Db, p: PlaybookRow, t: ScheduleTrigger, now: Date): Promise<string[]> {
  const slot = dueScheduleSlot(t, p.site_timezone, now, p.enabled_at ? new Date(p.enabled_at) : now, LIMITS.scheduleGraceMinutes);
  if (!slot) return [];
  const key = `schedule:${slot.toISOString()}`;
  if ((await db.query(`SELECT 1 FROM playbook_runs WHERE playbook_id = $1 AND trigger_key = $2`, [p.id, key])).rowCount) return [];
  const skip = (await overRateLimit(db, p)) ? rateLimitReason(p) : null;
  const id = await createRun(db, p, {
    kind: 'schedule',
    key,
    evidence: { slot: slot.toISOString(), schedule: t, title: `Scheduled run (${slot.toISOString()})` },
    siteId: p.site_id,
    deviceId: null,
    incidentId: null,
    eventId: null,
    dryRun: p.dry_run,
    skipReason: skip,
  });
  return id && !skip ? [id] : [];
}

/** Start the runs whose trigger matched, for one organization. Returns the new run ids. */
export function matchTriggers(organizationId: string, now: Date): Promise<string[]> {
  return withTenant(organizationId, async (db) => {
    const playbooks = (await db.query<PlaybookRow>(`${PLAYBOOK_SELECT} WHERE p.enabled AND p.trigger ->> 'kind' <> 'manual' ORDER BY p.created_at`)).rows;
    const created: string[] = [];
    for (const p of playbooks) {
      await db.query('SAVEPOINT playbook_match');
      try {
        if (p.trigger.kind === 'event') created.push(...(await matchEvents(db, p, p.trigger, now)));
        else if (p.trigger.kind === 'incident') created.push(...(await matchIncidents(db, p, p.trigger, now)));
        else if (p.trigger.kind === 'schedule') created.push(...(await matchSchedule(db, p, p.trigger, now)));
        await db.query('RELEASE SAVEPOINT playbook_match');
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT playbook_match');
        logger.error({ err, playbook_id: p.id }, 'playbook trigger matching failed');
      }
    }
    return created;
  });
}

/** Runs whose next step is due (new runs, waits, polls, approval expiries). The database clock also counts: runs it just created are due. */
export function dueRuns(organizationId: string, now: Date): Promise<string[]> {
  return withTenant(organizationId, async (db) =>
    (
      await db.query<{ id: string }>(`SELECT id FROM playbook_runs WHERE status = ANY($1) AND next_run_at <= greatest($2::timestamptz, now()) ORDER BY next_run_at LIMIT 100`, [ACTIVE_RUN_STATUSES, now])
    ).rows.map((r) => r.id),
  );
}

/**
 * The scheduler job (every 5 s, single-runner across API instances): match triggers, then advance
 * every due run. Because all state is in the database this also resumes runs after a restart.
 */
export async function playbookTick(now = new Date()): Promise<void> {
  const orgs = (
    await systemPool.query<{ organization_id: string }>(
      `SELECT organization_id FROM playbooks WHERE enabled UNION SELECT organization_id FROM playbook_runs WHERE status = ANY($1)`,
      [ACTIVE_RUN_STATUSES],
    )
  ).rows.map((r) => r.organization_id);
  for (const org of orgs) {
    try {
      await matchTriggers(org, now);
      for (const runId of await dueRuns(org, now)) await advanceRun(org, runId, now);
    } catch (err) {
      logger.error({ err, organization_id: org }, 'playbook engine pass failed');
    }
  }
}
