import type { Request } from 'express';
import type { FleetConnectTarget } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { queueCommand } from '../commands/service.ts';
import { wakeCreateSchema } from '../remote-desktop/schema.ts';
import { requestWake } from '../remote-desktop/session-tools.ts';
import type { BulkAction } from './schema.ts';

// The Fleet address book (migration 037): tags, per-operator favourites, bulk actions on a
// selection, and "connect by computer name, Nigafiy ID or Quick Support code".

/** Adds / removes tags on several computers (admin). Tags are kept sorted and unique. */
export async function bulkTags(req: Request, ctx: AuthContext, endpointIds: string[], add: string[], remove: string[]): Promise<{ updated: number }> {
  return withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<{ id: string; tags: string[] }>(
      `UPDATE endpoints
          SET tags = (SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}')
                        FROM unnest(array_cat(tags, $2::text[])) AS t
                       WHERE NOT (t = ANY ($3::text[])))
        WHERE id = ANY ($1::uuid[]) AND kind = 'agent'
        RETURNING id, tags`,
      [endpointIds, add, remove],
    );
    if (r.rows.some((row) => row.tags.length > 20)) throw new AppError(422, 'too_many_tags', 'A computer can have at most 20 tags');
    await audit(db, req, 'fleet.tags_changed', { type: 'endpoint', id: null }, { endpoint_ids: r.rows.map((x) => x.id), add, remove });
    return { updated: r.rowCount ?? 0 };
  });
}

/** Marks or unmarks a favourite for the signed-in operator. */
export async function setFavourite(ctx: AuthContext, endpointId: string, on: boolean): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM endpoints WHERE id = $1 AND kind = 'agent'`, [endpointId])).rowCount) throw notFound('Endpoint');
    if (on) {
      await db.query(`INSERT INTO fleet_favourites (organization_id, user_id, endpoint_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.organizationId, ctx.userId, endpointId]);
    } else {
      await db.query(`DELETE FROM fleet_favourites WHERE user_id = $1 AND endpoint_id = $2`, [ctx.userId, endpointId]);
    }
  });
}

export interface BulkItemResult {
  endpoint_id: string;
  ok: boolean;
  code?: string;
  message?: string;
}

/**
 * One action on each selected computer, through the same function a single action uses, so the
 * role checks (power restart/shutdown: admin), platform guards, session profile checks and audit
 * rows are exactly those of the single action. Every computer gets its own result.
 */
export async function bulkAction(req: Request, ctx: AuthContext, body: BulkAction): Promise<{ results: BulkItemResult[] }> {
  const ids = [...new Set(body.endpoint_ids)];
  const known = await withTenant(ctx.organizationId, (db) => db.query<{ id: string }>(`SELECT id FROM endpoints WHERE id = ANY ($1::uuid[]) AND kind = 'agent'`, [ids]));
  const valid = new Set(known.rows.map((r) => r.id));
  const results: BulkItemResult[] = [];
  for (const id of ids) {
    if (!valid.has(id)) {
      results.push({ endpoint_id: id, ok: false, code: 'not_found', message: 'Endpoint not found' });
      continue;
    }
    try {
      if (body.action === 'notify') await queueCommand(req, ctx, id, { kind: 'notify_user', title: body.title, message: body.message });
      else if (body.action === 'power') await queueCommand(req, ctx, id, { kind: 'power_action', action: body.power, reason: body.reason });
      else if (body.action === 'refresh_inventory') await queueCommand(req, ctx, id, { kind: 'refresh_inventory' });
      else await requestWake(req, ctx, id, wakeCreateSchema.parse({ reason: body.reason }));
      results.push({ endpoint_id: id, ok: true });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      results.push({ endpoint_id: id, ok: false, code: err.code, message: err.message });
    }
  }
  await withTenant(ctx.organizationId, (db) =>
    audit(db, req, 'fleet.bulk_action', { type: 'endpoint', id: null }, { action: body.action, endpoints: ids.length, succeeded: results.filter((r) => r.ok).length }),
  );
  return { results };
}

/**
 * "Connect by name, ID or code". A 9-digit number is first a Nigafiy ID in this organization, then
 * a live Quick Support code (which still needs its PIN: nothing about the computer is shown before).
 * Anything else matches a computer name or host name exactly (case-insensitive), then by prefix.
 */
export async function resolveConnectTarget(ctx: AuthContext, raw: string): Promise<{ targets: FleetConnectTarget[] }> {
  const q = raw.trim();
  const digits = q.replace(/[\s-]/g, '');
  return withTenant(ctx.organizationId, async (db) => {
    const cols = `e.id, e.name, e.nigafiy_id, e.hostname, e.connection_state, s.name AS site_name, e.platform`;
    const from = `FROM endpoints e JOIN sites s ON s.organization_id = e.organization_id AND s.id = e.site_id WHERE e.kind = 'agent' AND e.status = 'active'`;
    type Row = Extract<FleetConnectTarget, { kind: 'endpoint' }>['endpoint'];
    if (/^[1-9][0-9]{8}$/.test(digits)) {
      const byId = await db.query<Row>(`SELECT ${cols} ${from} AND e.nigafiy_id = $1`, [digits]);
      if (byId.rows[0]) return { targets: [{ kind: 'endpoint', endpoint: byId.rows[0] }] };
      const qs = await db.query(`SELECT 1 FROM fleet_quick_support WHERE code = $1 AND state = 'waiting' AND expires_at > now()`, [digits]);
      if (qs.rowCount) return { targets: [{ kind: 'quick_support', code: digits, needs_pin: true }] };
      return { targets: [] };
    }
    const exact = await db.query<Row>(`SELECT ${cols} ${from} AND (lower(e.name) = lower($1) OR lower(e.hostname) = lower($1)) ORDER BY e.name LIMIT 10`, [q]);
    if (exact.rows.length) return { targets: exact.rows.map((endpoint) => ({ kind: 'endpoint' as const, endpoint })) };
    const like = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    const prefix = await db.query<Row>(`SELECT ${cols} ${from} AND (e.name ILIKE $1 OR e.hostname ILIKE $1) ORDER BY e.name LIMIT 10`, [`${like}%`]);
    return { targets: prefix.rows.map((endpoint) => ({ kind: 'endpoint' as const, endpoint })) };
  });
}
