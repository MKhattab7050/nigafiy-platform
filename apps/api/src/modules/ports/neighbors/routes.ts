import { Router } from 'express';
import { z } from 'zod';
import { auth, parse, requireRole } from '../../../common/http.ts';
import { neighborsReport, setMndpListen } from './service.ts';

const siteQuery = z.object({ site_id: z.uuid() });
const mndpSettingsSchema = z.object({ site_id: z.uuid(), mndp_listen: z.boolean() }).strict();

/**
 * Neighbours: GET /neighbors?site_id= (switch neighbour tables by protocol, MNDP announcements heard by
 * the site's collectors, and each collector's listener status) and PUT /neighbors/settings (admin).
 */
export const neighborsRouter: Router = Router();

neighborsRouter.get('/neighbors', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(siteQuery, req.query);
  res.json(await neighborsReport(ctx.organizationId, site_id));
});

neighborsRouter.put('/neighbors/settings', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(mndpSettingsSchema, req.body);
  await setMndpListen(req, ctx, body.site_id, body.mndp_listen);
  res.json({ ok: true, mndp_listen: body.mndp_listen });
});
