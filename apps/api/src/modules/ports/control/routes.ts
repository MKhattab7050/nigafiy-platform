import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import {
  portActionSchema,
  portParams,
  quarantineSchema,
  quarantineVlanSchema,
  releaseSchema,
  requestListQuery,
  sitePortControlSchema,
  writeCredentialsSchema,
} from './schema.ts';
import {
  clearWriteCredentials,
  deviceQuarantine,
  getPortRequest,
  listPortRequests,
  portControl,
  quarantineDevice,
  releaseQuarantine,
  requestPortChange,
  setSitePortControl,
  setSwitchQuarantineVlan,
  setWriteCredentials,
  sitePortControl,
  switchControl,
} from './service.ts';

/**
 * Port control (Phase 5). Reading is open to every member; every change is admin-only, confirmed
 * explicitly (`confirm: true`), audited, and runs only through the site's collector.
 *
 *   GET    /switches/:id/control                      VLANs, write-credential state, pending changes, quarantines
 *   PUT    /switches/:id/write-credentials            SNMP write credentials (write-only)
 *   DELETE /switches/:id/write-credentials
 *   PUT    /switches/:id/quarantine-vlan              per-switch quarantine VLAN (null: the site's)
 *   GET    /switches/:id/ports/:ifIndex/control       what can be changed on one port, and its risks
 *   POST   /switches/:id/ports/:ifIndex/actions       request one change (admin status, description, access VLAN)
 *   GET    /port-requests, /port-requests/:id         history with before / after
 *   GET    /sites/:id/port-control, PUT               the site's quarantine VLAN
 *   GET    /devices/:id/quarantine, POST              quarantine a device
 *   POST   /quarantines/:id/release                   put the port back in its original VLAN
 */
export const controlRouter: Router = Router();

controlRouter.get('/switches/:id/control', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await switchControl(ctx.organizationId, id));
});

controlRouter.put('/switches/:id/write-credentials', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { credentials } = parse(writeCredentialsSchema, req.body);
  await setWriteCredentials(req, ctx, id, credentials);
  res.json({ ok: true });
});

controlRouter.delete('/switches/:id/write-credentials', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await clearWriteCredentials(req, ctx, id);
  res.status(204).end();
});

controlRouter.put('/switches/:id/quarantine-vlan', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { vlan } = parse(quarantineVlanSchema, req.body);
  await setSwitchQuarantineVlan(req, ctx, id, vlan);
  res.json({ ok: true });
});

controlRouter.get('/switches/:id/ports/:ifIndex/control', async (req, res) => {
  const ctx = auth(req);
  const { id, ifIndex } = parse(portParams, req.params);
  res.json(await portControl(req, ctx.organizationId, id, ifIndex));
});

controlRouter.post('/switches/:id/ports/:ifIndex/actions', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id, ifIndex } = parse(portParams, req.params);
  const body = parse(portActionSchema, req.body);
  res.status(202).json(await requestPortChange(req, ctx, id, ifIndex, body));
});

controlRouter.get('/port-requests', async (req, res) => {
  const ctx = auth(req);
  res.json(await listPortRequests(ctx.organizationId, parse(requestListQuery, req.query)));
});

controlRouter.get('/port-requests/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await getPortRequest(ctx.organizationId, id));
});

controlRouter.get('/sites/:id/port-control', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await sitePortControl(ctx.organizationId, id));
});

controlRouter.put('/sites/:id/port-control', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { quarantine_vlan } = parse(sitePortControlSchema, req.body);
  await setSitePortControl(req, ctx, id, quarantine_vlan);
  res.json({ ok: true });
});

controlRouter.get('/devices/:id/quarantine', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await deviceQuarantine(req, ctx.organizationId, id));
});

controlRouter.post('/devices/:id/quarantine', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { reason } = parse(quarantineSchema, req.body);
  res.status(202).json(await quarantineDevice(req, ctx, id, reason));
});

controlRouter.post('/quarantines/:id/release', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  parse(releaseSchema, req.body);
  res.status(202).json(await releaseQuarantine(req, ctx, id));
});
