import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { auth } from '../../common/http.ts';
import { tlsStatus } from '../../infrastructure/lan-tls.ts';
import { type ModuleManifest, defineModule } from '../../infrastructure/module.ts';
import { applyRetention } from './retention.ts';
import { jobHealth } from '../../infrastructure/scheduler.ts';
import { systemHealth } from './health.ts';
import { modulesReport, scheduledJobsOf } from './service.ts';

const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')).version ?? '') || null;
  } catch {
    return null;
  }
})();

/**
 * Platform housekeeping: GET /system/modules (registered modules and background-job health, any
 * role) and the cross-module data-retention job.
 *
 * The module list is passed in (instead of importing the registry) so the registry can include
 * this module without an import cycle.
 */
export function createSystemModule(listModules: () => readonly ModuleManifest[]): ModuleManifest {
  const router: Router = Router();
  router.get('/system/modules', (req, res) => {
    auth(req); // session already verified by requireSession; any role may read this
    res.json(modulesReport(listModules()));
  });

  // System Health: is the API, the database, the background work and monitoring all right, and does anything need the user.
  router.get('/system/health', async (req, res) => {
    const ctx = auth(req);
    res.json(await systemHealth(ctx.organizationId, jobHealth(scheduledJobsOf(listModules())), VERSION));
  });

  // HTTPS of this API process: mode, the fingerprint collectors / agents pin, certificate dates and
  // the names and addresses it covers. Public facts (anyone on the network sees the certificate).
  router.get('/system/tls', (req, res) => {
    auth(req);
    res.json(tlsStatus());
  });

  return defineModule({
    name: 'system',
    api: router,
    jobs: [{ name: 'retention', everyMs: 3600_000, lockKey: 727103, run: applyRetention }],
  });
}

export { scheduledJobsOf } from './service.ts';
