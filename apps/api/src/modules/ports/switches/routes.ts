import { Router } from 'express';
import { AppError, auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { portHistoryParams, portHistoryQuery, switchCreateSchema, switchListQuery, switchPatchSchema } from '../schema.ts';
import { listSwitchCandidates } from './detection.ts';
import { addSwitch, getPortHistory, getSwitchDetail, listSwitches, removeSwitch, requestPoll, updateSwitch } from './service.ts';

/** Switch management and port detail: /switches, /switches/:id, /switches/:id/poll, /switches/:id/ports/:ifIndex/history. */
export const switchesRouter: Router = Router();

switchesRouter.get('/switches', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(switchListQuery, req.query);
  res.json({ items: await listSwitches(ctx.organizationId, site_id) });
});

switchesRouter.post('/switches', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(switchCreateSchema, req.body);
  res.status(201).json(await addSwitch(req, ctx, body));
});

switchesRouter.patch('/switches/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(switchPatchSchema, req.body);
  await updateSwitch(req, ctx, id, body);
  res.json({ ok: true });
});

switchesRouter.delete('/switches/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await removeSwitch(req, ctx, id);
  res.status(204).end();
});

switchesRouter.post('/switches/:id/poll', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const queued = await requestPoll(ctx, id);
  if (!queued) throw new AppError(409, 'no_collector', 'No collector of this site is online to read the switch');
  res.status(202).json({ queued: true });
});

/**
 * Devices that are probably switches but are not read yet (classified router/switch/access point/
 * firewall, or LLDP neighbours of read switches). Suggestions only: adding one still needs the
 * user to enter its SNMP credentials in POST /switches — none are guessed or prefilled.
 */
switchesRouter.get('/sites/:id/switch-candidates', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await listSwitchCandidates(ctx.organizationId, id));
});

switchesRouter.get('/switches/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await getSwitchDetail(ctx.organizationId, id));
});

switchesRouter.get('/switches/:id/ports/:ifIndex/history', async (req, res) => {
  const ctx = auth(req);
  const { id, ifIndex } = parse(portHistoryParams, req.params);
  const { range } = parse(portHistoryQuery, req.query);
  res.json(await getPortHistory(ctx.organizationId, id, ifIndex, range));
});
