import { Router } from 'express';
import { z } from 'zod';
import type { Collector, CollectorCreated } from '@nigafiy/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, publicServerUrl, requireRole } from '../../common/http.ts';
import { randomToken, sha256 } from '../../common/crypto.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { resolveOpenIncidentByKey } from '../correlation/index.ts';
import { notifyRealtime } from '../realtime/index.ts';

export const collectorsRouter: Router = Router();

const ENROLLMENT_TTL_HOURS = 24;

const COLLECTOR_SELECT = `
  SELECT c.id, c.site_id, s.name AS site_name, c.name, c.status, c.connection_state, c.hostname, c.version, c.os, c.arch,
         host(c.gateway_ip) AS gateway_ip, c.spool_depth, c.last_heartbeat_at,
         CASE WHEN c.status = 'pending' THEN c.enrollment_expires_at END AS enrollment_expires_at, c.created_at
    FROM collectors c JOIN sites s ON s.id = c.site_id`;

function newEnrollmentToken(): { token: string; hash: string; expires: Date } {
  const token = `lde_${randomToken(32)}`;
  return { token, hash: sha256(token), expires: new Date(Date.now() + ENROLLMENT_TTL_HOURS * 3600_000) };
}

collectorsRouter.get('/collectors', async (req, res) => {
  const ctx = auth(req);
  const result = await withTenant(ctx.organizationId, (db) => db.query<Collector>(`${COLLECTOR_SELECT} ORDER BY s.name, c.name`));
  res.json({ items: result.rows });
});

collectorsRouter.post('/collectors', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(z.object({ site_id: z.uuid(), name: z.string().trim().min(1).max(80) }), req.body);
  const enrollment = newEnrollmentToken();
  const collector = await withTenant(ctx.organizationId, async (db) => {
    const site = await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id]);
    if (!site.rowCount) throw notFound('Site');
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO collectors (organization_id, site_id, name, enrollment_token_hash, enrollment_expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.organizationId, body.site_id, body.name, enrollment.hash, enrollment.expires, ctx.userId],
    );
    const id = inserted.rows[0]!.id;
    await audit(db, req, 'collector.created', { type: 'collector', id }, { name: body.name, site_id: body.site_id });
    return (await db.query<Collector>(`${COLLECTOR_SELECT} WHERE c.id = $1`, [id])).rows[0]!;
  });
  const response: CollectorCreated = { collector, enrollment_token: enrollment.token, ...publicServerUrl(req) };
  res.status(201).json(response);
});

/** Issue a fresh single-use enrollment token for a collector that has not enrolled yet. */
collectorsRouter.post('/collectors/:id/enrollment-token', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const enrollment = newEnrollmentToken();
  const collector = await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE collectors SET enrollment_token_hash = $2, enrollment_expires_at = $3 WHERE id = $1 AND status = 'pending'`,
      [id, enrollment.hash, enrollment.expires],
    );
    if (!updated.rowCount) throw new AppError(409, 'not_pending', 'Only collectors that have not enrolled yet can get a new enrollment token');
    await audit(db, req, 'collector.enrollment_token_reissued', { type: 'collector', id });
    return (await db.query<Collector>(`${COLLECTOR_SELECT} WHERE c.id = $1`, [id])).rows[0]!;
  });
  const response: CollectorCreated = { collector, enrollment_token: enrollment.token, ...publicServerUrl(req) };
  res.json(response);
});

/** Revocation is immediate: the credential hash is erased, so the collector's next request is rejected. */
collectorsRouter.post('/collectors/:id/revoke', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE collectors SET status = 'revoked', revoked_at = now(), credential_hash = NULL, enrollment_token_hash = NULL
        WHERE id = $1 AND status <> 'revoked'`,
      [id],
    );
    if (!updated.rowCount) throw notFound('Collector');
    if (await resolveOpenIncidentByKey(db, ctx.organizationId, `collector:${id}`, 'the collector was revoked')) {
      await notifyRealtime(db, ctx.organizationId, 'events');
    }
    await audit(db, req, 'collector.revoked', { type: 'collector', id });
    await notifyRealtime(db, ctx.organizationId, 'collectors');
  });
  res.json({ ok: true });
});

/** Ask a collector to run discovery now. It is picked up on the collector's next heartbeat (outbound polling). */
collectorsRouter.post('/collectors/:id/scan', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const collector = await db.query<{ status: string }>(`SELECT status FROM collectors WHERE id = $1`, [id]);
    if (!collector.rows[0]) throw notFound('Collector');
    if (collector.rows[0].status !== 'active') throw new AppError(409, 'collector_not_active', 'This collector is not enrolled and active');
    const pending = await db.query(`SELECT 1 FROM collector_commands WHERE collector_id = $1 AND kind = 'run_discovery' AND status <> 'completed'`, [id]);
    if (!pending.rowCount) {
      await db.query(`INSERT INTO collector_commands (organization_id, collector_id, kind, created_by) VALUES ($1,$2,'run_discovery',$3)`, [
        ctx.organizationId,
        id,
        ctx.userId,
      ]);
      await audit(db, req, 'collector.scan_requested', { type: 'collector', id });
    }
  });
  res.status(202).json({ ok: true });
});
