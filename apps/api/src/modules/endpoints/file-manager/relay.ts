import { createHash } from 'node:crypto';
import { AppError, type AuthContext } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import type { EndpointContext } from '../schema.ts';

// The binary side channel of file transfers (docs/roadmap/2026-11-28-file-transfer-speed.md).
// The command (path, offset, checks) still goes through endpoint_commands with its audit, roles,
// policy and session profile; only a piece's bytes wait here, in the unlogged `file_relay` table,
// between the browser and the agent: binary, no base64, no WAL, seconds at most.

/** What an agent announces in its command poll when it fetches and sends bytes this way. */
export const FS_RELAY_FEATURE = 'fs_relay';
/** One piece: the agents write at most 2 MiB per upload chunk and read 1 MiB per download chunk. */
export const MAX_RELAY_BYTES = 2 * 1024 * 1024;
/** Leftovers (a closed tab, an agent that went away) are removed after this. */
const RELAY_TTL = "interval '10 minutes'";

const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function assertPiece(data: unknown): Buffer {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new AppError(400, 'empty_piece', 'Send the piece as application/octet-stream');
  if (data.length > MAX_RELAY_BYTES) throw new AppError(413, 'payload_too_large', 'A piece is at most 2 MiB');
  return data;
}

// ── Browser side ────────────────────────────────────────────────────────────────────────────

/** An upload piece from the browser (admin: uploading is an admin action). Returns its id. */
export async function storeUploadPiece(ctx: AuthContext, endpointId: string, body: unknown): Promise<{ id: string; size: number; sha256: string }> {
  const data = assertPiece(body);
  return withTenant(ctx.organizationId, async (db) => {
    const ep = await db.query(`SELECT 1 FROM endpoints WHERE id = $1`, [endpointId]);
    if (!ep.rowCount) throw new AppError(404, 'not_found', 'Endpoint not found');
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO file_relay (organization_id, endpoint_id, direction, created_by, data) VALUES ($1, $2, 'up', $3, $4) RETURNING id`,
        [ctx.organizationId, endpointId, ctx.userId, data],
      )
    ).rows[0]!.id;
    return { id, size: data.length, sha256: sha256Hex(data) };
  });
}

/**
 * The bytes of a download piece, for the operator who asked for it (once: the row goes as it is
 * read; a retry asks the device again). Null when there are none (never relayed, or already read).
 */
export async function takeDownloadPiece(ctx: AuthContext, endpointId: string, commandId: string): Promise<Buffer | null> {
  return withTenant(ctx.organizationId, async (db) => {
    const own = await db.query(
      `SELECT 1 FROM endpoint_commands WHERE id = $1 AND endpoint_id = $2 AND kind = 'fs_op' AND payload->>'op' = 'download' AND created_by = $3`,
      [commandId, endpointId, ctx.userId],
    );
    if (!own.rowCount) throw new AppError(404, 'not_found', 'No such download');
    const row = (
      await db.query<{ data: Buffer }>(
        `DELETE FROM file_relay WHERE id = (SELECT id FROM file_relay WHERE command_id = $1 AND endpoint_id = $2 AND direction = 'down' LIMIT 1) RETURNING data`,
        [commandId, endpointId],
      )
    ).rows[0];
    return row?.data ?? null;
  });
}

// ── Command queueing ────────────────────────────────────────────────────────────────────────

/**
 * Fits an fs_op payload to what the agent can do. A download asks for the side channel only from an
 * agent that announced it. An upload's data_ref must be a piece this operator sent for this
 * endpoint; an agent that cannot fetch it gets the bytes inside the command as before (base64).
 */
export async function fitRelayPayload(db: Db, ctx: AuthContext, endpointId: string, features: readonly string[] | null, payload: Record<string, unknown>): Promise<void> {
  const relay = (features ?? []).includes(FS_RELAY_FEATURE);
  if (payload.op === 'download' && payload.relay && !relay) delete payload.relay;
  if (payload.op !== 'upload' || typeof payload.data_ref !== 'string') return;
  const piece = (
    await db.query<{ size: number; data: Buffer | null }>(
      `SELECT length(data) AS size, CASE WHEN $4 THEN NULL ELSE data END AS data
         FROM file_relay WHERE id = $1 AND endpoint_id = $2 AND direction = 'up' AND created_by = $3 AND created_at > now() - ${RELAY_TTL}`,
      [payload.data_ref, endpointId, ctx.userId, relay],
    )
  ).rows[0];
  if (!piece) throw new AppError(409, 'relay_piece_missing', 'The uploaded piece is gone; send it again');
  payload.data_len = Number(piece.size);
  if (!relay) {
    payload.data_base64 = piece.data!.toString('base64');
    await db.query(`DELETE FROM file_relay WHERE id = $1`, [payload.data_ref]);
    delete payload.data_ref;
    delete payload.data_len;
  }
}

// ── Agent side ──────────────────────────────────────────────────────────────────────────────

/** The bytes of an upload piece, for the agent of its endpoint. */
export async function readUploadPiece(ep: EndpointContext, ref: string): Promise<Buffer | null> {
  return withTenant(ep.organizationId, async (db) => {
    const row = (await db.query<{ data: Buffer }>(`SELECT data FROM file_relay WHERE id = $1 AND endpoint_id = $2 AND direction = 'up'`, [ref, ep.id])).rows[0];
    return row?.data ?? null;
  });
}

/** A download piece from the agent: only for a download command of its own endpoint still running. */
export async function storeDownloadPiece(ep: EndpointContext, commandId: string, body: unknown): Promise<void> {
  const data = assertPiece(body);
  await withTenant(ep.organizationId, async (db) => {
    const cmd = await db.query(
      `SELECT 1 FROM endpoint_commands WHERE id = $1 AND endpoint_id = $2 AND kind = 'fs_op' AND payload->>'op' = 'download' AND status IN ('pending', 'delivered')`,
      [commandId, ep.id],
    );
    if (!cmd.rowCount) throw new AppError(404, 'not_found', 'No such running download');
    await db.query(`DELETE FROM file_relay WHERE command_id = $1 AND direction = 'down'`, [commandId]);
    await db.query(`INSERT INTO file_relay (organization_id, endpoint_id, direction, command_id, data) VALUES ($1, $2, 'down', $3, $4)`, [
      ep.organizationId,
      ep.id,
      commandId,
      data,
    ]);
  });
}

/** The features an agent announced in its poll; written only when they change (cached per instance). */
const knownFeatures = new Map<string, string>();
export async function recordAgentFeatures(ep: EndpointContext, raw: unknown): Promise<void> {
  const list = Array.isArray(raw) ? [...new Set(raw.filter((f): f is string => typeof f === 'string' && /^[a-z_]{1,32}$/.test(f)))].slice(0, 16).sort() : [];
  const key = list.join(',');
  if (knownFeatures.get(ep.id) === key) return;
  await withTenant(ep.organizationId, (db) => db.query(`UPDATE endpoints SET agent_features = $2 WHERE id = $1 AND agent_features IS DISTINCT FROM $2::text[]`, [ep.id, list]));
  knownFeatures.set(ep.id, key);
}

/** After a command ends: its upload piece is no longer needed. Plus leftovers of this endpoint. */
export async function sweepRelay(db: Db, endpointId: string, finishedCommandIds: readonly string[] = []): Promise<void> {
  if (finishedCommandIds.length) {
    await db.query(
      `DELETE FROM file_relay r USING endpoint_commands c
        WHERE c.id = ANY($1::uuid[]) AND c.endpoint_id = $2 AND r.id::text = c.payload->>'data_ref' AND r.direction = 'up'`,
      [finishedCommandIds, endpointId],
    );
  }
  await db.query(`DELETE FROM file_relay WHERE endpoint_id = $1 AND created_at < now() - ${RELAY_TTL}`, [endpointId]);
}
