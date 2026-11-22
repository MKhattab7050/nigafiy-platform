import { Router } from 'express';
import { auth } from '../../common/http.ts';
import { tlsStatus } from '../../infrastructure/lan-tls.ts';
import { type ModuleManifest, defineModule } from '../../infrastructure/module.ts';
import { applyRetention } from './retention.ts';
import { modulesReport } from './service.ts';

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
