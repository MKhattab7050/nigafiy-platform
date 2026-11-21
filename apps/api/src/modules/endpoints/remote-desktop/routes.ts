import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { rdStartSchema } from './schema.ts';
import { startSession, stopSession } from './service.ts';

/** Remote desktop sessions (technician): POST /endpoints/:id/remote-desktop/start | stop. */
export const remoteDesktopRouter: Router = Router();

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/start', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(rdStartSchema, req.body ?? {});
  res.json(await startSession(req, ctx, id, body));
});

remoteDesktopRouter.post('/endpoints/:id/remote-desktop/stop', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await stopSession(req, ctx, id);
  res.json({ ok: true });
});
