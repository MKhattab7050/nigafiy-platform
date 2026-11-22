import { defineModule } from '../../infrastructure/module.ts';
import { runConfigBackupJob } from './jobs.ts';
import { configBackupRouter } from './routes.ts';

/**
 * Configuration backup & version diffing: the running configuration of routers, switches and
 * firewalls, read over SSH by the site's collector (read-only, closed per-vendor command lists).
 *
 *   schema.ts       request validation, limits
 *   credentials.ts  SSH credentials (sealed at rest; decrypted only for the site's collector)
 *   commands.ts     adds the secrets to a pending `config_backup` command in the heartbeat answer
 *   service.ts      targets, runs, host-key decisions, versions, diffs, suggestions, SSH checks
 *   ingest.ts       config_backup_result / config_backup_probe_result telemetry → versions, events
 *   normalize.ts    volatile-line removal and the content hash (unchanged configs are stored once)
 *   diff.ts         bounded Myers line diff and unified-diff output
 *   detect.ts       vendor suggestion from the SSH banner, SNMP sysDescr and OUI (inferred)
 *   schedule.ts     daily backup time in the site's time zone
 *   jobs.ts         expiry, scheduled daily backups, daily SSH reachability check
 *
 * Nothing here changes a device: there is no restore and no configuration push.
 */
export const configBackupModule = defineModule({
  name: 'config-backup',
  api: configBackupRouter,
  jobs: [{ name: 'config-backup', everyMs: 300_000, lockKey: 727122, run: () => runConfigBackupJob() }],
});

export { withConfigBackupSecrets } from './commands.ts';
export { processConfigBackupItem } from './ingest.ts';
export { expireStale as expireStaleConfigBackups, loadTarget as loadConfigBackupTarget, onlineCollector as configBackupCollector, queueRun as queueConfigBackupRun, readiness as configBackupReadiness } from './service.ts';
