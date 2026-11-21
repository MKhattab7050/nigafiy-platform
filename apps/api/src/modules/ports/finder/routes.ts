import { Router } from 'express';
import { auth, idParams, parse } from '../../../common/http.ts';
import { portFindQuery } from '../schema.ts';
import { findPorts, locateDevice } from './service.ts';

/** Port finder: GET /devices/:id/port, GET /ports/find. */
export const finderRouter: Router = Router();

finderRouter.get('/devices/:id/port', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await locateDevice(ctx.organizationId, id));
});

/** Port Detective search: a name, IP or MAC → the port(s) it is on. */
finderRouter.get('/ports/find', async (req, res) => {
  const ctx = auth(req);
  const { q, site_id } = parse(portFindQuery, req.query);
  res.json({ items: await findPorts(ctx.organizationId, q, site_id) });
});
