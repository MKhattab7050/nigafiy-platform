import { auditSystem } from '../../common/audit.ts';
import type { Db } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { actedRecently, automationSetting } from '../automation/index.ts';

const KEY = 'incident.refresh_measurements';

/**
 * Automation `incident.refresh_measurements`: when a network-path or collector incident opens, ask
 * the site's online collectors to run every check now (the existing `run_checks` command), so
 * Network Doctor's diagnosis rests on fresh measurements instead of the last interval's.
 *
 *  - gated by the automation setting of the incident's site;
 *  - rate-limited per site (config.min_interval_minutes, default 5) from its own system audit
 *    entries, so a flapping incident cannot queue it again and again;
 *  - recorded with auditSystem();
 *  - isolated in a savepoint: a failure here is logged and can never make the incident fail to open.
 *
 * All SQL filters organization_id explicitly (this also runs in platform transactions).
 */
export async function refreshMeasurementsOnOpen(
  db: Db,
  org: string,
  incident: { id: string; kind: string; site_id: string | null; collector_id: string | null },
): Promise<void> {
  if (!incident.site_id || (incident.kind !== 'network' && incident.kind !== 'collector')) return;
  const siteId = incident.site_id;
  await db.query('SAVEPOINT automation_refresh');
  try {
    const setting = await automationSetting(db, org, siteId, KEY);
    if (setting.enabled && !(await actedRecently(db, org, KEY, siteId, Number(setting.config.min_interval_minutes) || 5))) {
      const collectors = (
        await db.query<{ id: string }>(
          `SELECT id FROM collectors WHERE organization_id = $1 AND site_id = $2 AND status = 'active' AND connection_state = 'online' ORDER BY id`,
          [org, siteId],
        )
      ).rows;
      const queued: string[] = [];
      for (const c of collectors) {
        const pending = await db.query(`SELECT 1 FROM collector_commands WHERE organization_id = $1 AND collector_id = $2 AND kind = 'run_checks' AND status <> 'completed'`, [org, c.id]);
        if (pending.rowCount) continue;
        await db.query(`INSERT INTO collector_commands (organization_id, collector_id, kind) VALUES ($1,$2,'run_checks')`, [org, c.id]);
        queued.push(c.id);
      }
      if (queued.length) {
        await auditSystem(db, org, {
          automation: KEY,
          action: 'collector.run_checks_queued',
          target: { type: 'incident', id: incident.id },
          siteId,
          metadata: { incident_kind: incident.kind, collectors: queued, reason: 'An incident opened; measuring now so the diagnosis uses fresh data' },
        });
      }
    }
    await db.query('RELEASE SAVEPOINT automation_refresh');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT automation_refresh');
    logger.error({ err, organization_id: org, incident_id: incident.id }, 'incident measurement refresh failed');
  }
}
