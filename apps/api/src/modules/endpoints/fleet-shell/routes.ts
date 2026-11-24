import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { shellListQuery, shellOpenSchema, shellParams } from './schema.ts';
import { closeShell, getShell, listShells, openShell, readTranscript } from './shells.ts';

/**
 * Fleet Pro: remote shell (migration 042). Admins only (a shell runs anything on the computer).
 *   POST /endpoints/:id/shell                          open (group switch, policy, MFA, profile "shell")
 *   GET  /endpoints/:id/shell/:shellId                 state
 *   POST /endpoints/:id/shell/:shellId/close           end
 *   GET  /endpoints/:id/shell/:shellId/transcript      the decrypted transcript (audited)
 *   GET  /fleet/shells?endpoint_id=&state=             history
 * The terminal itself is the WebSocket /endpoints/:id/shell/stream?shell= (hub.ts).
 */
export const fleetShellRouter: Router = Router();

fleetShellRouter.post('/endpoints/:id/shell', requireRole('technician'), async (req, res) => {
  // Technicians reach openShell so their refusal is audited (shell_admin_only).
  const { id } = parse(idParams, req.params);
  res.status(201).json(await openShell(req, auth(req), id, parse(shellOpenSchema, req.body)));
});

fleetShellRouter.get('/endpoints/:id/shell/:shellId', requireRole('admin'), async (req, res) => {
  const { id, shellId } = parse(shellParams, req.params);
  res.json(await getShell(auth(req), id, shellId));
});

fleetShellRouter.post('/endpoints/:id/shell/:shellId/close', requireRole('admin'), async (req, res) => {
  const { id, shellId } = parse(shellParams, req.params);
  res.json(await closeShell(req, auth(req), id, shellId));
});

fleetShellRouter.get('/endpoints/:id/shell/:shellId/transcript', requireRole('admin'), async (req, res) => {
  const { id, shellId } = parse(shellParams, req.params);
  res.json(await readTranscript(req, auth(req), id, shellId));
});

fleetShellRouter.get('/fleet/shells', requireRole('admin'), async (req, res) => {
  res.json({ shells: await listShells(auth(req), parse(shellListQuery, req.query)) });
});
