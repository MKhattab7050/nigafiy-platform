import express, { Router } from 'express';
import { AppError, auth, idParams, parse, requireRole } from '../../../common/http.ts';
import { commandInputSchema, parseWaitMs } from './schema.ts';
import { z } from 'zod';
import { ownFileCommandResult, queueCommand, waitForCommandResult } from './service.ts';
import { MAX_RELAY_BYTES, storeUploadPiece, takeDownloadPiece } from '../file-manager/relay.ts';

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

// The binary side channel of file transfers (file-manager/relay.ts): a piece's bytes, raw.
const rawPiece = express.raw({ type: 'application/octet-stream', limit: MAX_RELAY_BYTES });

/** An upload piece (admin, like uploading): its id goes into the upload command as data_ref. */
commandsRouter.post('/endpoints/:id/file-data', requireRole('admin'), rawPiece, async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.status(201).json(await storeUploadPiece(ctx, id, req.body));
});

/** A download piece the device sent apart (result_data.relayed), for the operator who asked; read once. */
commandsRouter.get('/endpoints/:id/commands/:commandId/data', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id, commandId } = parse(commandParams, req.params);
  const data = await takeDownloadPiece(ctx, id, commandId);
  if (!data) throw new AppError(404, 'relay_piece_missing', 'This piece is not here (already read or expired); ask the device again');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.end(data);
});

/** An upload chunk's bytes are not sent back to the browser that just sent them (1 MiB each). */
function withoutUploadBytes<T extends { kind: string; payload: unknown }>(cmd: T): T {
  const p = cmd.payload as Record<string, unknown> | null;
  if (cmd.kind !== 'fs_op' || !p || typeof p.data_base64 !== 'string') return cmd;
  const { data_base64: _bytes, ...rest } = p;
  return { ...cmd, payload: rest };
}
