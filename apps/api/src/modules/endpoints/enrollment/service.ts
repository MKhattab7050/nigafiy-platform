import type { Request } from 'express';
import type { EndpointCreated, EndpointSummary } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound, publicServerUrl } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { ENDPOINT_SUMMARY_SELECT, newEnrollmentToken } from '../repo.ts';
import type { EndpointCreate } from '../schema.ts';

// Enrollment lifecycle on the operator side: register an endpoint (and get its one-time token),
// re-issue the token while it has not enrolled, revoke it. The agent side is agent/service.ts.
// `req` is passed only for the audit trail (actor and source address).

export async function createEndpoint(req: Request, ctx: AuthContext, body: EndpointCreate): Promise<EndpointCreated> {
  const enrollment = newEnrollmentToken();

  const endpoint = await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount) throw notFound('Site');
    if (body.device_id) {
      if (!(await db.query(`SELECT 1 FROM devices WHERE id = $1 AND site_id = $2`, [body.device_id, body.site_id])).rowCount) {
        throw notFound('Device');
      }
    }
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO endpoints (organization_id, site_id, device_id, name, platform, enrollment_token_hash, enrollment_expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        ctx.organizationId,
        body.site_id,
        body.device_id ?? null,
        body.name,
        body.platform,
        enrollment.hash,
        enrollment.expires,
        ctx.userId,
      ],
    );
    const id = inserted.rows[0]!.id;
    await audit(db, req, 'endpoint.created', { type: 'endpoint', id }, {
      name: body.name,
      platform: body.platform,
      site_id: body.site_id,
      device_id: body.device_id ?? null,
    });
    return (await db.query<EndpointSummary>(`${ENDPOINT_SUMMARY_SELECT} WHERE e.id = $1`, [id])).rows[0]!;
  });

  return { endpoint, enrollment_token: enrollment.token, ...publicServerUrl(req) };
}

export async function reissueEnrollmentToken(req: Request, ctx: AuthContext, id: string): Promise<EndpointCreated> {
  const enrollment = newEnrollmentToken();
  const endpoint = await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE endpoints SET enrollment_token_hash = $2, enrollment_expires_at = $3 WHERE id = $1 AND status = 'pending'`,
      [id, enrollment.hash, enrollment.expires],
    );
    if (!updated.rowCount) throw new AppError(409, 'not_pending', 'Only endpoints that have not enrolled yet can get a new enrollment token');
    await audit(db, req, 'endpoint.enrollment_token_reissued', { type: 'endpoint', id });
    return (await db.query<EndpointSummary>(`${ENDPOINT_SUMMARY_SELECT} WHERE e.id = $1`, [id])).rows[0]!;
  });
  return { endpoint, enrollment_token: enrollment.token, ...publicServerUrl(req) };
}

export async function revokeEndpoint(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const updated = await db.query(
      `UPDATE endpoints SET status = 'revoked', connection_state = 'offline', revoked_at = now(), credential_hash = NULL, enrollment_token_hash = NULL, rd_session = NULL
        WHERE id = $1 AND status <> 'revoked'`,
      [id],
    );
    if (!updated.rowCount) throw notFound('Endpoint');
    await audit(db, req, 'endpoint.revoked', { type: 'endpoint', id });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}
