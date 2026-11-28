import { Router } from 'express';
import { AppError, auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { commandInputSchema, parseWaitMs } from './schema.ts';
import { z } from 'zod';
import { ownFileCommandResult, queueCommand, waitForCommandResult } from './service.ts';

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
      res.status(200).json(withoutUploadBytes(finished));
      return;
    }
  }

  res.status(202).json(withoutUploadBytes(cmd));
});

const commandParams = z.object({ id: z.string().uuid(), commandId: z.string().uuid() });

/** A file command's result, waited on up to 25 s (?wait_ms=); see ownFileCommandResult. */
commandsRouter.get('/endpoints/:id/commands/:commandId', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id, commandId } = parse(commandParams, req.params);
  const waitMs = Math.min(25_000, Math.max(0, Number.parseInt(String(req.query.wait_ms ?? '0'), 10) || 0));
  const cmd = await ownFileCommandResult(ctx.organizationId, ctx.userId, id, commandId, waitMs);
  if (!cmd) throw new AppError(404, 'not_found', 'No such file command');
  res.json(withoutUploadBytes(cmd));
});

/** An upload chunk's bytes are not sent back to the browser that just sent them (1 MiB each). */
function withoutUploadBytes<T extends { kind: string; payload: unknown }>(cmd: T): T {
  const p = cmd.payload as Record<string, unknown> | null;
  if (cmd.kind !== 'fs_op' || !p || typeof p.data_base64 !== 'string') return cmd;
  const { data_base64: _bytes, ...rest } = p;
  return { ...cmd, payload: rest };
}
