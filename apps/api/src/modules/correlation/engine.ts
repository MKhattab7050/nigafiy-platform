import type { Severity } from '@lan-detective/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { type IncidentRef, diagnoseIncident } from '../doctor/index.ts';
import { refreshMeasurementsOnOpen } from './refresh.ts';

/**
 * Alert correlation: turns the stream of events into a small number of incidents.
 *
 *  correlation key                 opened by                                   resolved when
 *  site:<id>:network               gateway/internet/DNS check down|degraded    every path check of the site is healthy again
 *  check:<id>                      a service check down|degraded               that check recovers
 *  collector:<id>                  collector lost contact                      collector reconnects
 *  device:<id>                     a device marked critical goes offline       the device is seen again
 *  site:<id>:dhcp-rogue|dhcp-none  rogue DHCP server / no DHCP offer           security module: nothing left open
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
  inMaintenance?: boolean;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

/** Correlation key of a site's DHCP incident: 'rogue' (unexpected server) or 'none' (no server answering). */
export const dhcpIncidentKey = (siteId: string, which: 'rogue' | 'none') => `site:${siteId}:dhcp-${which}`;
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
    await refreshMeasurementsOnOpen(db, org, incident);
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
      if (ev.type !== 'check_recovered') {
        if (ev.inMaintenance) return;
        return openOrAttach(db, org, ev, key, isPath ? 'network' : 'service');
      }
      const incident = await activeIncident(db, org, key);
      if (!incident) return;
      await link(db, org, incident.id, ev.id);
      if (!isPath) return resolve(db, org, incident, ev.occurredAt, 'the check recovered');
      const stillBad = await db.query(
        `SELECT 1 FROM monitoring_checks c
          WHERE c.organization_id = $1 AND c.site_id = $2 AND c.enabled AND c.role <> 'service' AND c.state IN ('down', 'degraded')
            AND NOT EXISTS (
              SELECT 1 FROM maintenance_windows w
               WHERE w.organization_id = c.organization_id
                 AND (w.site_id IS NULL OR w.site_id = c.site_id)
                 AND (w.target_all OR c.id = ANY(w.check_ids))
                 AND maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, $3) IS NOT NULL
            )
          LIMIT 1`,
        [org, ev.siteId, ev.occurredAt],
      );
      // Partially recovered: stay open, and keep the diagnosis made at the fault's fullest extent —
      // re-diagnosing now would describe the leftovers (e.g. "DNS") instead of the cause.
      if (stillBad.rowCount) return;
      return resolve(db, org, incident, ev.occurredAt, 'gateway, internet and DNS checks are all healthy again');
    }
    case 'collector_offline':
      if (ev.inMaintenance) return;
      if (ev.collectorId) await openOrAttach(db, org, ev, `collector:${ev.collectorId}`, 'collector');
      return;
    case 'collector_online': {
      const incident = ev.collectorId ? await activeIncident(db, org, `collector:${ev.collectorId}`) : undefined;
      if (!incident) return;
      await link(db, org, incident.id, ev.id);
      return resolve(db, org, incident, ev.occurredAt, 'the collector reconnected');
    }
    case 'device_offline': {
      if (ev.inMaintenance) return;
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
    // Smart checks (modules/security): a rogue DHCP server, or no DHCP server answering. The security
    // module resolves these incidents itself (resolveOpenIncidentByKey) once nothing is left open.
    case 'rogue_dhcp_server':
    case 'dhcp_no_offer':
      if (ev.inMaintenance || !ev.siteId) return;
      return openOrAttach(db, org, ev, dhcpIncidentKey(ev.siteId, ev.type === 'rogue_dhcp_server' ? 'rogue' : 'none'), 'dhcp');
    case 'rogue_dhcp_cleared':
    case 'dhcp_offer_restored': {
      const incident = ev.siteId ? await activeIncident(db, org, dhcpIncidentKey(ev.siteId, ev.type === 'rogue_dhcp_cleared' ? 'rogue' : 'none')) : undefined;
      if (incident) await link(db, org, incident.id, ev.id);
      return;
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

/** Auto-resolve an open or acknowledged incident by its correlation key (e.g. when a check is disabled/deleted or a collector is revoked). */
export async function resolveOpenIncidentByKey(db: Db, org: string, key: string, reason: string, at = new Date()): Promise<boolean> {
  await db.query('SAVEPOINT resolve_incident_by_key');
  try {
    const incident = await activeIncident(db, org, key);
    if (!incident) {
      await db.query('RELEASE SAVEPOINT resolve_incident_by_key');
      return false;
    }
    await resolve(db, org, incident, at, reason);
    await db.query('RELEASE SAVEPOINT resolve_incident_by_key');
    return true;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT resolve_incident_by_key');
    logger.error({ err, correlation_key: key, organization_id: org }, 'incident auto-resolve failed');
    return false;
  }
}

async function openSyntheticIncident(
  db: Db,
  org: string,
  params: {
    siteId: string;
    key: string;
    kind: Kind;
    severity: Severity;
    title: string;
    checkId?: string | null;
    deviceId?: string | null;
    collectorId?: string | null;
    eventId?: string | null;
    at: Date;
  },
): Promise<void> {
  const existing = await activeIncident(db, org, params.key);
  if (existing) return;
  const counter = await db.query<{ last_number: number }>(
    `INSERT INTO incident_counters (organization_id, last_number) VALUES ($1, 1)
     ON CONFLICT (organization_id) DO UPDATE SET last_number = incident_counters.last_number + 1 RETURNING last_number`,
    [org],
  );
  const inserted = await db.query<Row>(
    `INSERT INTO incidents (organization_id, site_id, number, kind, correlation_key, severity, title, check_id, device_id, collector_id, opened_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${INCIDENT_REF}`,
    [
      org,
      params.siteId,
      counter.rows[0]!.last_number,
      params.kind,
      params.key,
      params.severity,
      params.title,
      params.kind === 'service' ? (params.checkId ?? null) : null,
      params.kind === 'device' ? (params.deviceId ?? null) : null,
      params.kind === 'collector' ? (params.collectorId ?? null) : null,
      params.at,
    ],
  );
  const incident = inserted.rows[0]!;
  await activity(db, org, incident.id, 'opened', `Opened automatically: ${params.title}`, params.at);
  await refreshMeasurementsOnOpen(db, org, incident);
  if (params.eventId) {
    await link(db, org, incident.id, params.eventId);
  }
  await rediagnose(db, org, incident);
}

/**
 * Reconcile a site's active incidents with current live state after a check is disabled/deleted or
 * a maintenance window ends.
 */
export async function refreshSiteCorrelation(db: Db, org: string, siteId: string, at = new Date()): Promise<void> {
  await db.query('SAVEPOINT refresh_site_correlation');
  try {
    // 1. Network path incident for the site
    const badPathChecks = await db.query<{
      id: string;
      name: string;
      state: 'down' | 'degraded';
    }>(
      `SELECT c.id, c.name, c.state
         FROM monitoring_checks c
        WHERE c.organization_id = $1 AND c.site_id = $2 AND c.enabled AND c.role <> 'service' AND c.state IN ('down', 'degraded')
          AND NOT EXISTS (
            SELECT 1 FROM maintenance_windows w
             WHERE w.organization_id = c.organization_id
               AND (w.site_id IS NULL OR w.site_id = c.site_id)
               AND (w.target_all OR c.id = ANY(w.check_ids))
               AND maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, $3) IS NOT NULL
          )
        ORDER BY (c.state = 'down') DESC, c.name`,
      [org, siteId, at],
    );
    const networkKey = `site:${siteId}:network`;
    const netIncident = await activeIncident(db, org, networkKey);
    if (netIncident) {
      if (badPathChecks.rowCount === 0) {
        await resolve(db, org, netIncident, at, 'gateway, internet and DNS checks are all healthy again');
      } else {
        await rediagnose(db, org, netIncident);
      }
    } else if (badPathChecks.rows[0]) {
      const first = badPathChecks.rows[0];
      const hasDown = badPathChecks.rows.some((c) => c.state === 'down');
      const latestEv = await db.query<{ id: string; title: string }>(
        `SELECT id, title FROM network_events
          WHERE organization_id = $1 AND site_id = $2 AND check_id = ANY($3::uuid[])
            AND type IN ('check_down', 'check_degraded')
          ORDER BY occurred_at DESC LIMIT 1`,
        [org, siteId, badPathChecks.rows.map((c) => c.id)],
      );
      await openSyntheticIncident(db, org, {
        siteId,
        key: networkKey,
        kind: 'network',
        severity: hasDown ? 'critical' : 'warning',
        title: latestEv.rows[0]?.title ?? `${first.name}: ${first.state === 'down' ? 'not responding' : 'degraded performance'}`,
        eventId: latestEv.rows[0]?.id ?? null,
        at,
      });
    }

    // 2. Service checks that are down/degraded outside maintenance without an open incident
    const badServiceChecks = await db.query<{ id: string; name: string; state: 'down' | 'degraded' }>(
      `SELECT c.id, c.name, c.state
         FROM monitoring_checks c
        WHERE c.organization_id = $1 AND c.site_id = $2 AND c.enabled AND c.role = 'service' AND c.state IN ('down', 'degraded')
          AND NOT EXISTS (
            SELECT 1 FROM maintenance_windows w
             WHERE w.organization_id = c.organization_id
               AND (w.site_id IS NULL OR w.site_id = c.site_id)
               AND (w.target_all OR c.id = ANY(w.check_ids))
               AND maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, $3) IS NOT NULL
          )`,
      [org, siteId, at],
    );
    for (const sc of badServiceChecks.rows) {
      const key = `check:${sc.id}`;
      if (!(await activeIncident(db, org, key))) {
        const latestEv = await db.query<{ id: string; title: string }>(
          `SELECT id, title FROM network_events
            WHERE organization_id = $1 AND site_id = $2 AND check_id = $3
              AND type IN ('check_down', 'check_degraded')
            ORDER BY occurred_at DESC LIMIT 1`,
          [org, siteId, sc.id],
        );
        await openSyntheticIncident(db, org, {
          siteId,
          key,
          kind: 'service',
          severity: 'warning',
          title: latestEv.rows[0]?.title ?? `${sc.name}: ${sc.state === 'down' ? 'not responding' : 'degraded performance'}`,
          checkId: sc.id,
          eventId: latestEv.rows[0]?.id ?? null,
          at,
        });
      }
    }

    // 3. Active collectors that are offline outside maintenance without an open incident
    const offlineCollectors = await db.query<{ id: string; name: string }>(
      `SELECT c.id, c.name
         FROM collectors c
        WHERE c.organization_id = $1 AND c.site_id = $2 AND c.status = 'active' AND c.connection_state = 'offline'
          AND NOT EXISTS (
            SELECT 1 FROM maintenance_windows w
             WHERE w.organization_id = c.organization_id
               AND (w.site_id IS NULL OR w.site_id = c.site_id)
               AND (w.target_all OR c.id = ANY(w.collector_ids))
               AND maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, $3) IS NOT NULL
          )`,
      [org, siteId, at],
    );
    for (const col of offlineCollectors.rows) {
      const key = `collector:${col.id}`;
      if (!(await activeIncident(db, org, key))) {
        const latestEv = await db.query<{ id: string; title: string }>(
          `SELECT id, title FROM network_events
            WHERE organization_id = $1 AND site_id = $2 AND collector_id = $3 AND type = 'collector_offline'
            ORDER BY occurred_at DESC LIMIT 1`,
          [org, siteId, col.id],
        );
        await openSyntheticIncident(db, org, {
          siteId,
          key,
          kind: 'collector',
          severity: 'critical',
          title: latestEv.rows[0]?.title ?? `Collector "${col.name}" lost contact`,
          collectorId: col.id,
          eventId: latestEv.rows[0]?.id ?? null,
          at,
        });
      }
    }

    // 4. Critical devices that are offline outside maintenance without an open incident
    const offlineCriticalDevices = await db.query<{ id: string; label: string }>(
      `SELECT d.id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS label
         FROM devices d
        WHERE d.organization_id = $1 AND d.site_id = $2 AND d.is_critical AND d.status = 'offline'
          AND NOT EXISTS (
            SELECT 1 FROM maintenance_windows w
             WHERE w.organization_id = d.organization_id
               AND (w.site_id IS NULL OR w.site_id = d.site_id)
               AND (w.target_all OR d.id = ANY(w.device_ids))
               AND maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, $3) IS NOT NULL
          )`,
      [org, siteId, at],
    );
    for (const dev of offlineCriticalDevices.rows) {
      const key = `device:${dev.id}`;
      if (!(await activeIncident(db, org, key))) {
        const latestEv = await db.query<{ id: string; title: string }>(
          `SELECT id, title FROM network_events
            WHERE organization_id = $1 AND site_id = $2 AND device_id = $3 AND type = 'device_offline'
            ORDER BY occurred_at DESC LIMIT 1`,
          [org, siteId, dev.id],
        );
        await openSyntheticIncident(db, org, {
          siteId,
          key,
          kind: 'device',
          severity: 'critical',
          title: latestEv.rows[0]?.title ?? `Critical device "${dev.label}" went offline`,
          deviceId: dev.id,
          eventId: latestEv.rows[0]?.id ?? null,
          at,
        });
      }
    }

    await db.query('RELEASE SAVEPOINT refresh_site_correlation');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT refresh_site_correlation');
    logger.error({ err, organization_id: org, site_id: siteId }, 'site correlation refresh failed');
  }
}

export { activity as addActivity };
