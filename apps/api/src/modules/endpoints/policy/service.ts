import type { Request } from 'express';
import type { z } from 'zod';
import type { EndpointPlatform, EndpointPolicy, EndpointSecurityPosture } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { evaluateCompliance } from '../capabilities.ts';
import type { endpointPolicySchema } from '../schema.ts';

// Per-endpoint policy (allowed file-manager roots, remote-desktop consent). Compliance itself is
// evaluated from what the agent reports (capabilities.ts → evaluateCompliance).
// `req` is passed only for the audit trail.

/** Merges the given fields into the endpoint's policy and returns the resulting policy. */
export function updatePolicy(req: Request, ctx: AuthContext, id: string, body: z.infer<typeof endpointPolicySchema>): Promise<EndpointPolicy> {
  return withTenant(ctx.organizationId, async (db) => {
    const ep = (
      await db.query<{ id: string; policy: EndpointPolicy; platform: EndpointPlatform; security: EndpointSecurityPosture; disk_used_pct: number | null }>(
        `SELECT id, policy, platform, security, disk_used_pct FROM endpoints WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!ep) throw notFound('Endpoint');

    const mergedPolicy: EndpointPolicy = { ...(ep.policy ?? {}), ...body };
    // The allowed list of local administrators changes the verdict at once (not at the next heartbeat).
    const compliance = evaluateCompliance({ platform: ep.platform, diskUsedPct: ep.disk_used_pct, security: ep.security, allowedLocalAdmins: mergedPolicy.allowed_local_admins });
    await db.query(`UPDATE endpoints SET policy = $2::jsonb, compliance_status = $3, compliance_reasons = $4 WHERE id = $1`, [id, JSON.stringify(mergedPolicy), compliance.status, compliance.reasons]);
    await audit(db, req, 'endpoint.policy_updated', { type: 'endpoint', id }, mergedPolicy as Record<string, unknown>);
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return mergedPolicy;
  });
}
