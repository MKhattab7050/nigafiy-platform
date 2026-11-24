import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { auth, idParams, parse, publicServerUrl, requireRole } from '../../../common/http.ts';
import { env } from '../../../config/env.ts';
import { limiterStore } from '../../../infrastructure/rate-limit.ts';
import { rdStartSchema } from '../remote-desktop/schema.ts';
import { bulkAction, bulkTags, resolveConnectTarget, setFavourite } from './address-book.ts';
import { closeHelpRequest, listHelpRequests, startFromHelpRequest } from './help-requests.ts';
import { connectQuickSupport, downloadQuickSupport, listQuickSupport, quickSupportKey } from './quick-support.ts';
import { requestRestart, restartStatus } from './restarts.ts';
import {
  bulkActionSchema,
  helpCloseSchema,
  helpListQuery,
  quickConnectSchema,
  quickDownloadQuery,
  quickListQuery,
  resolveQuery,
  restartSchema,
  tagsBulkSchema,
} from './schema.ts';

/**
 * Fleet Pro: reaching computers (migration 037).
 *   POST   /fleet/address-book/tags                 admin   add / remove tags on a selection
 *   PUT|DELETE /fleet/favourites/:id                technician+ (own favourites)
 *   POST   /fleet/bulk                              technician+ (each action keeps its own role rule)
 *   GET    /fleet/connect/resolve?q=                technician+ name, Nigafiy ID or Quick Support code
 *   GET    /fleet/help-requests                     technician+
 *   POST   /fleet/help-requests/:id/connect | close technician+
 *   POST   /endpoints/:id/remote-desktop/restart    technician+ (the session holder, profile "restart")
 *   GET    /endpoints/:id/remote-desktop/restart    technician+ (status; resumes the session when back)
 *   GET    /fleet/quick-support                     technician+ (codes are masked while waiting)
 *   GET    /fleet/quick-support/key                 technician+ (fingerprint shown beside the download)
 *   GET    /fleet/quick-support/download?site_id=   technician+
 *   POST   /fleet/quick-support/connect             technician+, rate limited per operator
 */
export const fleetReachRouter: Router = Router();

const quickConnectLimiter = rateLimit({
  store: limiterStore('fleet:quick-connect'),
  windowMs: 10 * 60_000,
  limit: env.NODE_ENV === 'test' ? 40 : 15,
  keyGenerator: (req) => `u:${req.auth?.userId ?? 'anonymous'}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many Quick Support attempts: wait a few minutes' } },
});

fleetReachRouter.post('/fleet/address-book/tags', requireRole('admin'), async (req, res) => {
  const body = parse(tagsBulkSchema, req.body ?? {});
  res.json(await bulkTags(req, auth(req), body.endpoint_ids, body.add, body.remove));
});

fleetReachRouter.put('/fleet/favourites/:id', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await setFavourite(auth(req), id, true);
  res.json({ ok: true });
});

fleetReachRouter.delete('/fleet/favourites/:id', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await setFavourite(auth(req), id, false);
  res.json({ ok: true });
});

fleetReachRouter.post('/fleet/bulk', requireRole('technician'), async (req, res) => {
  res.json(await bulkAction(req, auth(req), parse(bulkActionSchema, req.body ?? {})));
});

fleetReachRouter.get('/fleet/connect/resolve', requireRole('technician'), async (req, res) => {
  const { q } = parse(resolveQuery, req.query);
  res.json(await resolveConnectTarget(auth(req), q));
});

fleetReachRouter.get('/fleet/help-requests', requireRole('technician'), async (req, res) => {
  const q = parse(helpListQuery, req.query);
  res.json({ requests: await listHelpRequests(auth(req), q.state, q.limit) });
});

fleetReachRouter.post('/fleet/help-requests/:id/connect', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await startFromHelpRequest(req, auth(req), id, parse(rdStartSchema, req.body ?? {})));
});

fleetReachRouter.post('/fleet/help-requests/:id/close', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  await closeHelpRequest(req, auth(req), id, parse(helpCloseSchema, req.body ?? {}).note);
  res.json({ ok: true });
});

fleetReachRouter.post('/endpoints/:id/remote-desktop/restart', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ restart: await requestRestart(req, auth(req), id, parse(restartSchema, req.body ?? {})) });
});

fleetReachRouter.get('/endpoints/:id/remote-desktop/restart', requireRole('technician'), async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json(await restartStatus(req, auth(req), id));
});

fleetReachRouter.get('/fleet/quick-support', requireRole('technician'), async (req, res) => {
  const q = parse(quickListQuery, req.query);
  res.json({ sessions: await listQuickSupport(auth(req), q.limit), key: quickSupportKey() });
});

fleetReachRouter.get('/fleet/quick-support/key', requireRole('technician'), (_req, res) => {
  res.json(quickSupportKey());
});

fleetReachRouter.get('/fleet/quick-support/download', requireRole('technician'), async (req, res) => {
  const { site_id } = parse(quickDownloadQuery, req.query);
  const server = publicServerUrl(req);
  const body = await downloadQuickSupport(req, auth(req), site_id, { url: server.server_url, pin: server.tls_pin_sha256 });
  res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
  res.setHeader('Content-Disposition', 'attachment; filename="nigafiy-support.exe"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
});

fleetReachRouter.post('/fleet/quick-support/connect', requireRole('technician'), quickConnectLimiter, async (req, res) => {
  res.json(await connectQuickSupport(req, auth(req), parse(quickConnectSchema, req.body ?? {})));
});
