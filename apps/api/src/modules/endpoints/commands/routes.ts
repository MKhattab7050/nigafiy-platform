import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { commandInputSchema, parseWaitMs } from './schema.ts';
import { queueCommand, waitForCommandResult } from './service.ts';

/** Remote commands (technician; some kinds admin): POST /endpoints/:id/commands[?wait_ms=]. */
export const commandsRouter: Router = Router();

commandsRouter.post('/endpoints/:id/commands', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(commandInputSchema, req.body);
  const waitMs = parseWaitMs(req.query.wait_ms);

  const cmd = await queueCommand(req, ctx, id, body);

  if (waitMs > 0) {
    const finished = await waitForCommandResult(ctx.organizationId, id, cmd.id, waitMs);
    if (finished) {
      res.status(200).json(finished);
      return;
    }
  }

  res.status(202).json(cmd);
});
