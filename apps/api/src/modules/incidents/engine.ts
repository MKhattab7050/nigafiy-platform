import type { Severity } from '@lan-detective/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { type IncidentRef, diagnoseIncident } from '../doctor/service.ts';

/**
 * Alert correlation: turns the stream of events into a small number of incidents.
 *
 *  correlation key                 opened by                                   resolved when
 *  site:<id>:network               gateway/internet/DNS check down|degraded    every path check of the site is healthy again
 *  check:<id>                      a service check down|degraded               that check recovers
 *  collector:<id>                  collector lost contact                      collector reconnects
 *  device:<id>                     a device marked critical goes offline       the device is seen again
 *
 * Later events with the same key attach to the open incident instead of creating a new one, and
 * ordinary device drop-outs during a network incident are attached to it as "affected".
 * All SQL filters organization_id explicitly (this also runs in platform transactions).
 */

export interface CorrelatableEvent {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  siteId: string | null;
  checkId: string | null;
  deviceId: string | null;
  collectorId: string | null;
  occurredAt: Date;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
type Kind = IncidentRef['kind'];
interface Row extends IncidentRef {
  severity: Severity;
}
const INCIDENT_REF = `id, kind, site_id, check_id, device_id, collector_id, opened_at, resolved_at, severity`;

async function activeIncident(db: Db, org: string, key: string): Promise<Row | undefined> {
  return (await db.query<Row>(`SELECT ${INCIDENT_REF} FROM incidents WHERE organization_id = $1 AND correlation_key = $2 AND status <> 'resolved' FOR UPDATE`, [org, key])).rows[0];
}

async function link(db: Db, org: string, incidentId: string, eventId: string): Promise<void> {
  await db.query(`INSERT INTO incident_events (incident_id, event_id, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [incidentId, eventId, org]);
}

async function activity(db: Db, org: string, incidentId: string, kind: string, body: string, at: Date, user?: { id: string; name: string }): Promise<void> {
  await db.query(`INSERT INTO incident_activity (organization_id, incident_id, kind, user_id, user_name, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    org,
    incidentId,
    kind,
    user?.id ?? null,
    user?.name ?? null,
    body,
    at,
  ]);
}

/** Re-run Network Doctor for an incident and store the result (title follows the diagnosis). */
export async function rediagnose(db: Db, org: string, incident: IncidentRef, note = true): Promise<void> {
  const diagnosis = await diagnoseIncident(db, org, incident);
  if (!diagnosis) return;
  const previous = await db.query<{ rule: string | null }>(`SELECT diagnosis ->> 'rule' AS rule FROM incidents WHERE organization_id = $1 AND id = $2`, [org, incident.id]);
  await db.query(`UPDATE incidents SET diagnosis = $3, diagnosed_at = now(), title = $4 WHERE organization_id = $1 AND id = $2`, [org, incident.id, JSON.stringify(diagnosis), diagnosis.title]);
  if (note && previous.rows[0]?.rule !== diagnosis.rule) {
    await activity(db, org, incident.id, 'diagnosis', `Network Doctor: ${diagnosis.title} — confidence ${diagnosis.confidence} (rule ${diagnosis.rule})`, new Date());
  }
}

async function openOrAttach(db: Db, org: string, ev: CorrelatableEvent, key: string, kind: Kind): Promise<void> {
  let incident = await activeIncident(db, org, key);
  if (!incident) {
    const counter = await db.query<{ last_number: number }>(
      `INSERT INTO incident_counters (organization_id, last_number) VALUES ($1, 1)
       ON CONFLICT (organization_id) DO UPDATE SET last_number = incident_counters.last_number + 1 RETURNING last_number`,
      [org],
    );
    const inserted = await db.query<Row>(
      `INSERT INTO incidents (organization_id, site_id, number, kind, correlation_key, severity, title, check_id, device_id, collector_id, opened_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${INCIDENT_REF}`,
      [org, ev.siteId, counter.rows[0]!.last_number, kind, key, ev.severity, ev.title, kind === 'service' ? ev.checkId : null, kind === 'device' ? ev.deviceId : null, kind === 'collector' ? ev.collectorId : null, ev.occurredAt],
    );
    incident = inserted.rows[0]!;
    await activity(db, org, incident.id, 'opened', `Opened automatically: ${ev.title}`, ev.occurredAt);
  } else if (RANK[ev.severity] > RANK[incident.severity]) {
    await db.query(`UPDATE incidents SET severity = $3 WHERE organization_id = $1 AND id = $2`, [org, incident.id, ev.severity]);
  }
  await link(db, org, incident.id, ev.id);
  await rediagnose(db, org, incident);
}

async function resolve(db: Db, org: string, incident: Row, at: Date, reason: string): Promise<void> {
  // The diagnosis is deliberately NOT re-run here: it must keep describing the fault, not the recovery.
  await db.query(`UPDATE incidents SET status = 'resolved', resolved_at = $3, resolution_kind = 'auto', resolution_note = $4 WHERE organization_id = $1 AND id = $2`, [org, incident.id, at, reason]);
  await activity(db, org, incident.id, 'resolved', `Resolved automatically: ${reason}`, at);
}

async function correlate(db: Db, org: string, ev: CorrelatableEvent): Promise<void> {
  const networkKey = ev.siteId ? `site:${ev.siteId}:network` : null;
  switch (ev.type) {
    case 'check_down':
    case 'check_degraded':
    case 'check_recovered': {
      if (!ev.checkId || !ev.siteId) return;
      const role = (await db.query<{ role: string }>(`SELECT role FROM monitoring_checks WHERE organization_id = $1 AND id = $2`, [org, ev.checkId])).rows[0]?.role;
      if (!role) return;
      const isPath = role !== 'service';
      const key = isPath ? networkKey! : `check:${ev.checkId}`;
      if (ev.type !== 'check_recovered') return openOrAttach(db, org, ev, key, isPath ? 'network' : 'service');
      const incident = await activeIncident(db, org, key);
      if (!incident) return;
      await link(db, org, incident.id, ev.id);
      if (!isPath) return resolve(db, org, incident, ev.occurredAt, 'the check recovered');
      const stillBad = await db.query(
        `SELECT 1 FROM monitoring_checks WHERE organization_id = $1 AND site_id = $2 AND enabled AND role <> 'service' AND state IN ('down', 'degraded') LIMIT 1`,
        [org, ev.siteId],
      );
      // Partially recovered: stay open, and keep the diagnosis made at the fault's fullest extent —
      // re-diagnosing now would describe the leftovers (e.g. "DNS") instead of the cause.
      if (stillBad.rowCount) return;
      return resolve(db, org, incident, ev.occurredAt, 'gateway, internet and DNS checks are all healthy again');
    }
    case 'collector_offline':
      if (ev.collectorId) await openOrAttach(db, org, ev, `collector:${ev.collectorId}`, 'collector');
      return;
    case 'collector_online': {
      const incident = ev.collectorId ? await activeIncident(db, org, `collector:${ev.collectorId}`) : undefined;
      if (!incident) return;
      await link(db, org, incident.id, ev.id);
      return resolve(db, org, incident, ev.occurredAt, 'the collector reconnected');
    }
    case 'device_offline': {
      if (!ev.deviceId) return;
      if (ev.severity === 'critical') return openOrAttach(db, org, ev, `device:${ev.deviceId}`, 'device');
      // A non-critical drop-out during a network incident is a symptom of it.
      const network = networkKey ? await activeIncident(db, org, networkKey) : undefined;
      if (network) {
        await link(db, org, network.id, ev.id);
        await rediagnose(db, org, network);
      }
      return;
    }
    case 'device_online': {
      const incident = ev.deviceId ? await activeIncident(db, org, `device:${ev.deviceId}`) : undefined;
      if (!incident) return;
      await link(db, org, incident.id, ev.id);
      return resolve(db, org, incident, ev.occurredAt, 'the device is responding again');
    }
    default:
  }
}

/**
 * Called for every emitted event, inside the caller's transaction. Runs in a savepoint so that a
 * correlation failure can never lose the event or the telemetry that produced it.
 */
export async function correlateEvent(db: Db, org: string, ev: CorrelatableEvent): Promise<void> {
  await db.query('SAVEPOINT correlate');
  try {
    await correlate(db, org, ev);
    await db.query('RELEASE SAVEPOINT correlate');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT correlate');
    logger.error({ err, event_type: ev.type, organization_id: org }, 'incident correlation failed');
  }
}

/**
 * After a collector reconnects it uploads what it measured while cut off. That evidence settles
 * why it was silent, so the (already resolved) collector incident gets its diagnosis refined.
 */
export async function refineCollectorIncident(db: Db, org: string, collectorId: string): Promise<void> {
  const rows = await db.query<Row>(
    `SELECT ${INCIDENT_REF} FROM incidents
      WHERE organization_id = $1 AND collector_id = $2 AND kind = 'collector' AND status = 'resolved'
        AND resolved_at > now() - interval '30 minutes' AND diagnosis ->> 'rule' IN ('collector-silent', 'collector-not-measuring')
      ORDER BY resolved_at DESC LIMIT 1`,
    [org, collectorId],
  );
  if (rows.rows[0]) await rediagnose(db, org, rows.rows[0]);
}

export { activity as addActivity };
