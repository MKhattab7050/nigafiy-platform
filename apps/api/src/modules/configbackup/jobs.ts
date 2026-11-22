import { withSystem, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { resanitizeLegacy } from './resanitize.ts';
import { nextDailyRun } from './schedule.ts';
import { PROBE_EVERY_HOURS } from './schema.ts';
import { expireStale, loadTarget, onlineCollector, queueProbe, queueRun, readiness } from './service.ts';

/**
 * The configuration-backup job (every 5 minutes, single-runner across API instances):
 *   1. runs and SSH checks not reported in time expire (their commands are withdrawn);
 *   2. daily backups that are due are queued for an online collector of their site. A device that is
 *      not ready (no credentials, credentials rejected, host key changed, out of scope) is skipped and
 *      moved to its next day — the reason is visible on the device; nothing is retried blindly;
 *   3. once a day per site, a read-only SSH reachability check of the site's known devices refreshes
 *      the "devices worth backing up" suggestions (TCP connect + identification line; no login).
 * A due backup whose site has no online collector stays due and starts when the collector is back.
 */
export async function runConfigBackupJob(now = new Date()): Promise<void> {
  const orgs = await withSystem(async (db) => {
    await expireStale(db);
    // Versions stored before secret sanitization (migration 041) are converted in bounded batches.
    await resanitizeLegacy(db);
    const due = await db.query<{ organization_id: string }>(
      `SELECT DISTINCT organization_id FROM config_backup_targets WHERE enabled AND schedule = 'daily' AND next_run_at <= $1`,
      [now],
    );
    const probe = await db.query<{ organization_id: string; site_id: string }>(
      `SELECT s.organization_id, s.id AS site_id FROM sites s
        WHERE EXISTS (SELECT 1 FROM collectors c WHERE c.site_id = s.id AND c.status = 'active' AND c.last_heartbeat_at > $1::timestamptz - interval '3 minutes')
          AND EXISTS (SELECT 1 FROM network_scopes sc WHERE sc.site_id = s.id AND sc.enabled)
          AND NOT EXISTS (SELECT 1 FROM config_backup_probe_runs p WHERE p.site_id = s.id AND (p.status = 'pending' OR p.created_at > $1::timestamptz - make_interval(hours => $2)))`,
      [now, PROBE_EVERY_HOURS],
    );
    return { due: due.rows.map((r) => r.organization_id), probe: probe.rows };
  });

  for (const org of orgs.due) {
    try {
      await withTenant(org, async (db) => {
        const targets = await db.query<{ id: string }>(
          `SELECT id FROM config_backup_targets WHERE enabled AND schedule = 'daily' AND next_run_at <= $1 ORDER BY next_run_at LIMIT 200`,
          [now],
        );
        const collectors = new Map<string, { id: string; name: string } | null>();
        for (const { id } of targets.rows) {
          const t = await loadTarget(db, id, true);
          if (!collectors.has(t.site_id)) collectors.set(t.site_id, await onlineCollector(db, t.site_id));
          const collector = collectors.get(t.site_id);
          if (!collector) continue; // stays due until a collector of the site is online
          if (!t.pending_run_id && readiness(t) === 'ready') await queueRun(db, org, t, 'scheduled', collector, null);
          await db.query(`UPDATE config_backup_targets SET next_run_at = $2 WHERE id = $1`, [t.id, nextDailyRun(now, t.site_timezone, t.schedule_hour, t.id)]);
        }
      });
    } catch (err) {
      // One organization's failure must not stop the others' backups.
      logger.error({ err, organization_id: org }, 'scheduled configuration backups failed for an organization');
    }
  }

  for (const { organization_id, site_id } of orgs.probe) {
    try {
      await withTenant(organization_id, async (db) => {
        const collector = await onlineCollector(db, site_id);
        if (collector) await queueProbe(db, organization_id, site_id, 'scheduled', collector, null);
      });
    } catch (err) {
      logger.error({ err, organization_id, site_id }, 'scheduled SSH reachability check failed for a site');
    }
  }
}
