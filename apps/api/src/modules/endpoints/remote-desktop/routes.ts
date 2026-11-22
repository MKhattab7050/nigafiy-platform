import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { rdStartSchema, sessionListQuery } from './schema.ts';
import { getSessionStatus, listSessions, startSession, stopSession } from './service.ts';

/**
 * Remote desktop sessions (technician):
 *   POST /endpoints/:id/remote-desktop/start | stop
 *   GET  /endpoints/:id/remote-desktop/session   current session, consent state, live stream
 *   GET  /fleet/sessions                         session history (fleet_sessions)
 * The live picture travels over the WebSocket of stream-hub.ts.
 */
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

remoteDesktopRouter.get('/endpoints/:id/remote-desktop/session', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await getSessionStatus(ctx, id));
});

remoteDesktopRouter.get('/fleet/sessions', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const q = parse(sessionListQuery, req.query);
  res.json({ sessions: await listSessions(ctx, q) });
});
