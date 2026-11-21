import { Router } from 'express';
import { auth, idParams, parse } from '../../../common/http.ts';
import { endpointListQuery, seriesQuery } from '../schema.ts';
import { getEndpointDetail, getSeries, listEndpoints } from './service.ts';

/** Fleet & inventory (read): GET /endpoints, GET /endpoints/:id, GET /endpoints/:id/series. */
export const fleetRouter: Router = Router();

fleetRouter.get('/endpoints', async (req, res) => {
  const ctx = auth(req);
  const q = parse(endpointListQuery, req.query);
  res.json({ items: await listEndpoints(ctx.organizationId, q) });
});

fleetRouter.get('/endpoints/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await getEndpointDetail(ctx.organizationId, id, ctx.role));
});

fleetRouter.get('/endpoints/:id/series', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const q = parse(seriesQuery, req.query);
  res.json(await getSeries(ctx.organizationId, id, q.range));
});
