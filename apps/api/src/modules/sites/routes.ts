import { Router } from 'express';
import { z } from 'zod';
import type { NetworkScope, Site } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { validateScope } from '../../common/net.ts';
import { timeZoneSchema } from '../../common/timezone.ts';
import { systemPool, withTenant } from '../../infrastructure/db.ts';
import { createDefaultChecks } from '../monitoring/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { suggestScopes } from './scope-suggestions.ts';

export const sitesRouter: Router = Router();

const SITE_COLUMNS = `id, name, timezone, discovery_interval_seconds, created_at`;
const SCOPE_COLUMNS = `id, site_id, cidr::text AS cidr, label, enabled, authorized_by_name, authorized_at, last_run_finished_at`;

const siteFields = {
  name: z.string().trim().min(1).max(80),
  // IANA zone (validated, stored canonically). Bedtimes and other local times of the site are evaluated in it.
  timezone: timeZoneSchema,
  discovery_interval_seconds: z.number().int().min(60).max(86400),
};
const siteInput = z.object({
  ...siteFields,
  timezone: siteFields.timezone.default('UTC'),
  discovery_interval_seconds: siteFields.discovery_interval_seconds.default(300),
});
// No defaults here: a field left out of a PATCH keeps its stored value (defaults inside .partial() would reset it).
const sitePatch = z.object(siteFields).partial();

sitesRouter.get('/sites', async (req, res) => {
  const ctx = auth(req);
  const sites = await withTenant(ctx.organizationId, (db) => db.query<Site>(`SELECT ${SITE_COLUMNS} FROM sites ORDER BY name`));
  res.json({ items: sites.rows });
});

sitesRouter.post('/sites', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(siteInput, req.body);
  const site = await withTenant(ctx.organizationId, async (db) => {
    const inserted = await db.query<Site>(
      `INSERT INTO sites (organization_id, name, timezone, discovery_interval_seconds) VALUES ($1,$2,$3,$4) RETURNING ${SITE_COLUMNS}`,
      [ctx.organizationId, body.name, body.timezone, body.discovery_interval_seconds],
    );
    const row = inserted.rows[0]!;
    await createDefaultChecks(db, ctx.organizationId, row.id);
    await audit(db, req, 'site.created', { type: 'site', id: row.id }, { name: row.name });
    return row;
  });
  res.status(201).json(site);
});

sitesRouter.patch('/sites/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(sitePatch, req.body);
  const site = await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query<Site>(
      `UPDATE sites SET name = coalesce($2, name), timezone = coalesce($3, timezone),
              discovery_interval_seconds = coalesce($4, discovery_interval_seconds)
        WHERE id = $1 RETURNING ${SITE_COLUMNS}`,
      [id, body.name ?? null, body.timezone ?? null, body.discovery_interval_seconds ?? null],
    );
    if (!updated.rows[0]) throw notFound('Site');
    await audit(db, req, 'site.updated', { type: 'site', id }, body);
    return updated.rows[0];
  });
  res.json(site);
});

// ── Authorized network scopes ──

sitesRouter.get('/scopes', async (req, res) => {
  const ctx = auth(req);
  const q = parse(z.object({ site_id: z.uuid().optional() }), req.query);
  const scopes = await withTenant(ctx.organizationId, (db) =>
    db.query<NetworkScope>(`SELECT ${SCOPE_COLUMNS} FROM network_scopes WHERE ($1::uuid IS NULL OR site_id = $1) ORDER BY cidr`, [q.site_id ?? null]),
  );
  res.json({ items: scopes.rows });
});

const scopeInput = z.object({
  cidr: z.string().trim().min(7).max(18),
  label: z.string().trim().max(80).optional(),
  // The administrator must explicitly attest ownership/authorization. Recorded with their identity.
  authorization_confirmed: z.literal(true, { error: 'You must confirm that you are authorized to monitor this network' }),
});

sitesRouter.post('/sites/:id/scopes', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id: siteId } = parse(idParams, req.params);
  const body = parse(scopeInput, req.body);
  const check = validateScope(body.cidr);
  if (!check.ok) throw new AppError(400, 'invalid_scope', check.reason!);
  const user = await systemPool.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [ctx.userId]);

  const scope = await withTenant(ctx.organizationId, async (db) => {
    const site = await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId]);
    if (!site.rowCount) throw notFound('Site');
    const overlap = await db.query<{ cidr: string }>(
      `SELECT cidr::text AS cidr FROM network_scopes WHERE site_id = $1 AND cidr && $2::cidr LIMIT 1`,
      [siteId, check.cidr],
    );
    if (overlap.rows[0]) throw new AppError(409, 'scope_overlap', `This range overlaps the existing scope ${overlap.rows[0].cidr}`);
    const inserted = await db.query<NetworkScope>(
      `INSERT INTO network_scopes (organization_id, site_id, cidr, label, authorized_by, authorized_by_name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${SCOPE_COLUMNS}`,
      [ctx.organizationId, siteId, check.cidr, body.label || null, ctx.userId, user.rows[0]?.display_name ?? ctx.userEmail],
    );
    const row = inserted.rows[0]!;
    await audit(db, req, 'scope.authorized', { type: 'network_scope', id: row.id }, { cidr: row.cidr, site_id: siteId });
    await notifyRealtime(db, ctx.organizationId, 'collectors');
    return row;
  });
  res.status(201).json(scope);
});

sitesRouter.patch('/scopes/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ enabled: z.boolean().optional(), label: z.string().trim().max(80).optional() }), req.body);
  const scope = await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query<NetworkScope>(
      `UPDATE network_scopes SET enabled = coalesce($2, enabled), label = coalesce($3, label) WHERE id = $1 RETURNING ${SCOPE_COLUMNS}`,
      [id, body.enabled ?? null, body.label ?? null],
    );
    if (!updated.rows[0]) throw notFound('Scope');
    await audit(db, req, 'scope.updated', { type: 'network_scope', id }, body);
    return updated.rows[0];
  });
  res.json(scope);
});

sitesRouter.delete('/scopes/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const deleted = await db.query<{ cidr: string }>(`DELETE FROM network_scopes WHERE id = $1 RETURNING cidr::text AS cidr`, [id]);
    if (!deleted.rows[0]) throw notFound('Scope');
    await audit(db, req, 'scope.removed', { type: 'network_scope', id }, { cidr: deleted.rows[0].cidr });
  });
  res.status(204).end();
});

/**
 * Networks the site's collectors are attached to that no scope covers yet. Suggestions only:
 * authorizing one is still POST /sites/:id/scopes with authorization_confirmed (admin).
 */
sitesRouter.get('/sites/:id/scope-suggestions', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await suggestScopes(ctx.organizationId, id));
});
