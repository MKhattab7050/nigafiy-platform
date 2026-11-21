import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../common/http.ts';
import { maintenanceCreateSchema, maintenanceListQuery, maintenancePatchSchema } from './schema.ts';
import {
  createMaintenanceWindow,
  deleteMaintenanceWindow,
  listMaintenance,
  updateMaintenanceWindow,
} from './service.ts';

export const maintenanceRouter: Router = Router();

maintenanceRouter.get('/maintenance', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(maintenanceListQuery, req.query);
  res.json(await listMaintenance(ctx.organizationId, site_id));
});

maintenanceRouter.post('/maintenance', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(maintenanceCreateSchema, req.body);
  res.status(201).json(await createMaintenanceWindow(req, ctx, body));
});

maintenanceRouter.patch('/maintenance/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(maintenancePatchSchema, req.body);
  res.json(await updateMaintenanceWindow(req, ctx, id, body));
});

maintenanceRouter.delete('/maintenance/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await deleteMaintenanceWindow(req, ctx, id);
  res.status(204).end();
});
