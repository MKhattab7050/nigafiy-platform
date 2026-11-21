import { Router } from 'express';
import { z } from 'zod';
import type { ImpactFailure } from '@lan-detective/shared-types';
import { AppError, auth, idParams, notFound, parse } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { ImpactInputError, findSpofs, simulate, twinGraph } from './graph.ts';
import { loadTwin } from './repo.ts';

/**
 * Digital twin. Every role that can see the site may read and simulate: a simulation changes nothing,
 * so it is not audited (requests are logged at debug level only).
 */
export const impactRouter: Router = Router();

const siteQuery = z.object({ site_id: z.uuid() });
const ref = z.string().trim().min(1).max(300);
const failure = z.discriminatedUnion('type', [
  z.object({ type: z.literal('node'), id: ref }),
  z.object({ type: z.literal('device'), id: z.uuid() }),
  z.object({ type: z.literal('collector'), id: z.uuid() }),
  z.object({ type: z.literal('port'), id: ref, port: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal('link'), id: ref }),
  z.object({ type: z.literal('site') }),
]);
const simulateBody = z.object({ site_id: z.uuid(), failures: z.array(failure).min(1).max(50) });

const run = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ImpactInputError) throw new AppError(422, 'invalid_failure', err.message);
    throw err;
  }
};

impactRouter.get('/impact/graph', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(siteQuery, req.query);
  const twin = await withTenant(ctx.organizationId, (db) => loadTwin(db, site_id));
  res.json(twinGraph(twin));
});

impactRouter.post('/impact/simulate', async (req, res) => {
  const ctx = auth(req);
  const body = parse(simulateBody, req.body);
  logger.debug({ organization_id: ctx.organizationId, site_id: body.site_id, failures: body.failures.map((f) => f.type) }, 'impact simulation requested');
  const twin = await withTenant(ctx.organizationId, (db) => loadTwin(db, body.site_id));
  res.json(run(() => simulate(twin, body.failures as ImpactFailure[])));
});

impactRouter.get('/impact/spof', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(siteQuery, req.query);
  const twin = await withTenant(ctx.organizationId, (db) => loadTwin(db, site_id));
  res.json(findSpofs(twin));
});

/** "What depends on this device?" — the impact of this one device failing. */
impactRouter.get('/impact/devices/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  logger.debug({ organization_id: ctx.organizationId, device_id: id }, 'device dependents requested');
  const twin = await withTenant(ctx.organizationId, async (db) => {
    const device = (await db.query<{ site_id: string }>(`SELECT site_id FROM devices WHERE id = $1`, [id])).rows[0];
    if (!device) throw notFound('Device');
    return loadTwin(db, device.site_id);
  });
  res.json(run(() => simulate(twin, [{ type: 'device', id }])));
});
