import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../common/http.ts';
import { changeBlocks, setRateLimit, setSchedule } from './control.ts';
import { deviceControls } from './controls.ts';
import {
  certificateTrustSchema,
  deviceIdsSchema,
  deviceParams,
  portForwardSchema,
  rateLimitSchema,
  rebootSchema,
  renameSchema,
  reservationSchema,
  routerCreateSchema,
  routerListQuery,
  routerPatchSchema,
  ruleParams,
  scheduleSchema,
  wifiSchema,
} from './schema.ts';
import {
  addRouter,
  listRouters,
  removeRouter,
  requestCertificate,
  requestRefresh,
  requestStatus,
  routerClients,
  routerDetail,
  trustCertificate,
  updateRouter,
} from './service.ts';
import { addPortForward, rebootRouter, removePortForward, removeReservation, renameOnRouter, reserveAddress, routerSettings, setWifi } from './settings.ts';

export const routersRouter: Router = Router();

routersRouter.get('/routers', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(routerListQuery, req.query);
  res.json({ items: await listRouters(ctx.organizationId, site_id) });
});

routersRouter.post('/routers', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  res.status(201).json(await addRouter(req, ctx, parse(routerCreateSchema, req.body)));
});

routersRouter.get('/routers/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await routerDetail(ctx.organizationId, id));
});

routersRouter.patch('/routers/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await updateRouter(req, ctx, id, parse(routerPatchSchema, req.body)));
});

routersRouter.delete('/routers/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await removeRouter(req, ctx, id);
  res.status(204).end();
});

routersRouter.post('/routers/:id/certificate/fetch', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.status(202).json(await requestCertificate(req, ctx, id));
});

routersRouter.post('/routers/:id/certificate/trust', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { sha256 } = parse(certificateTrustSchema, req.body);
  res.json(await trustCertificate(req, ctx, id, sha256));
});

routersRouter.post('/routers/:id/refresh', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.status(202).json(await requestRefresh(req, ctx, id));
});

routersRouter.get('/routers/:id/clients', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await routerClients(ctx.organizationId, id));
});

routersRouter.post('/routers/:id/block', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { device_ids } = parse(deviceIdsSchema, req.body);
  res.status(202).json(await changeBlocks(req, ctx, id, device_ids, 'block'));
});

routersRouter.post('/routers/:id/unblock', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { device_ids } = parse(deviceIdsSchema, req.body);
  res.status(202).json(await changeBlocks(req, ctx, id, device_ids, 'unblock'));
});

routersRouter.post('/routers/:id/rate-limit', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(rateLimitSchema, req.body);
  res.status(202).json(await setRateLimit(req, ctx, id, body.device_id, body.limit));
});

routersRouter.post('/routers/:id/schedule', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(scheduleSchema, req.body);
  res.status(202).json(await setSchedule(req, ctx, id, body.device_id, body.windows));
});

// Router controls beyond blocking (docs/features/router-controls.md). Reads: any role; changes: admin.
routersRouter.get('/routers/:id/settings', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await routerSettings(ctx.organizationId, id));
});

routersRouter.post('/routers/:id/rename', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(renameSchema, req.body);
  res.status(202).json(await renameOnRouter(req, ctx, id, body.device_id, body.name));
});

routersRouter.post('/routers/:id/wifi', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.status(202).json(await setWifi(req, ctx, id, parse(wifiSchema, req.body)));
});

routersRouter.post('/routers/:id/reservations', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(reservationSchema, req.body);
  res.status(202).json(await reserveAddress(req, ctx, id, body.device_id, body.ip));
});

routersRouter.delete('/routers/:id/reservations/:device_id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id, device_id } = parse(deviceParams, req.params);
  res.status(202).json(await removeReservation(req, ctx, id, device_id));
});

routersRouter.post('/routers/:id/port-forwards', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.status(202).json(await addPortForward(req, ctx, id, parse(portForwardSchema, req.body)));
});

routersRouter.delete('/routers/:id/port-forwards/:rule_id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id, rule_id } = parse(ruleParams, req.params);
  res.status(202).json(await removePortForward(req, ctx, id, rule_id));
});

routersRouter.post('/routers/:id/reboot', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  parse(rebootSchema, req.body);
  res.status(202).json(await rebootRouter(req, ctx, id));
});

routersRouter.get('/router-requests/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await requestStatus(ctx.organizationId, id));
});

routersRouter.get('/devices/:id/controls', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await deviceControls(req, ctx.organizationId, id));
});
