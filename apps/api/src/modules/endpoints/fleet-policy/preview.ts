import type { Request } from 'express';
import type { FleetPolicyPreview } from '@nigafiy/shared-types';
import { type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { effectivePolicy, ipAllowed, normalizeIp, pickableProfiles, withinHours } from './policy.ts';
import { recordingRule } from '../remote-desktop/session-tools.ts';
import { listProfilesIn } from './profiles.ts';
import { operatorHasMfa } from './step-up.ts';

/**
 * GET /endpoints/:id/remote-desktop/policy: the policy the connect dialog shows before the request
 * (which profiles may be picked, whether a code or an approval is needed, whether the role, the
 * address and the hours pass now). The request itself re-evaluates everything: this is advice only.
 */
export async function policyPreview(req: Request, ctx: AuthContext, endpointId: string): Promise<FleetPolicyPreview> {
  const hasMfa = await operatorHasMfa(ctx.userId);
  const requestIp = normalizeIp(req.ip);
  return withTenant(ctx.organizationId, async (db) => {
    const eff = await effectivePolicy(db, ctx.organizationId, endpointId);
    if (!eff) throw notFound('Endpoint');
    const all = await listProfilesIn(db);
    const max = all.find((p) => p.id === eff.policy.max_profile_id)!;
    const rec = await recordingRule(db, endpointId);
    return {
      source: eff.source,
      group: eff.group,
      policy: eff.policy,
      site_timezone: eff.timezone,
      profiles: pickableProfiles(all, max),
      default_profile_id: eff.policy.default_profile_id,
      max_profile: max,
      within_hours: withinHours(eff.policy, new Date(), eff.timezone),
      role_allowed: ctx.role !== 'viewer' && eff.policy.allowed_roles.includes(ctx.role as 'owner' | 'admin' | 'technician'),
      ip_allowed: ipAllowed(eff.policy.ip_allowlist, requestIp),
      request_ip: requestIp,
      operator_has_mfa: hasMfa,
      approval_needed: eff.policy.access_mode === 'unattended' && eff.policy.approval_required,
      recording_mode: rec.mode,
      recording_retention_days: rec.retentionDays,
    };
  });
}
