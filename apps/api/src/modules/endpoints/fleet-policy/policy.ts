import ipaddr from 'ipaddr.js';
import type {
  EndpointPolicy,
  FleetAccessPolicy,
  FleetGroup,
  FleetPermissionKey,
  FleetPermissionProfile,
  FleetPermissions,
  FleetPolicyTrailItem,
  Role,
} from '@nigafiy/shared-types';
import { cidrContains } from '../../../common/net.ts';
import { safeTimeZone } from '../../../common/timezone.ts';
import type { Db } from '../../../infrastructure/db.ts';
import { windowState } from '../../routers/product-schedule.ts';
import { builtinProfile, clampPermissions, ensureBuiltinProfiles, exceeding, permissionsOf, profileById } from './profiles.ts';

// The access policy that governs a remote support session to one endpoint, and its evaluation.
//
// An endpoint in a fleet group gets the group's policy. An endpoint in no group gets the
// organization default, derived from endpoints.policy.remote_desktop_consent so the API that
// existed before groups behaves as it did: "prompt" → attended (60 s), otherwise unattended; any
// hours, any operator role, no MFA step, no approval, any address; default profile Support (what a
// session could do before profiles: see and control, clipboard both ways), maximum Full admin.
//
// evaluatePolicy is pure. Checks run in this order and the first failure refuses the request with
// its code (the web shows each code in English and Arabic):
//   policy_role_not_allowed   the operator's role is not in allowed_roles
//   policy_ip_not_allowed     the request address is not in ip_allowlist
//   policy_outside_hours      now is outside allowed_hours (endpoint's site time zone)
//   policy_mfa_not_enrolled   MFA is required and the operator has no authenticator set up
//   policy_mfa_required       MFA is required and no step-up token came with the request
//   policy_mfa_invalid        the step-up token is expired, forged, or another user's/session's
//   profile_no_view           the granted profile cannot see the screen (a remote desktop needs it)

export type RefusalCode =
  | 'policy_role_not_allowed'
  | 'policy_ip_not_allowed'
  | 'policy_outside_hours'
  | 'policy_mfa_not_enrolled'
  | 'policy_mfa_required'
  | 'policy_mfa_invalid'
  | 'profile_no_view';

export const REFUSAL_MESSAGES: Record<RefusalCode, string> = {
  policy_role_not_allowed: 'The access policy of this computer does not allow your role to connect',
  policy_ip_not_allowed: 'The access policy of this computer does not allow connections from your address',
  policy_outside_hours: 'The access policy of this computer does not allow sessions at this time',
  policy_mfa_not_enrolled: 'The access policy of this computer requires multi-factor authentication. Set up an authenticator app in your account first.',
  policy_mfa_required: 'The access policy of this computer requires a verification code before connecting',
  policy_mfa_invalid: 'The verification has expired or is not valid. Enter a new code.',
  profile_no_view: 'The permission profile does not allow seeing the screen',
};

export interface EffectivePolicy {
  source: 'group' | 'organization_default';
  group: { id: string; name: string } | null;
  policy: FleetAccessPolicy;
  timezone: string;
}

const GROUP_POLICY_COLUMNS = `g.id, g.name, g.access_mode, g.consent_timeout_s, g.refuse_window_s, g.allowed_hours, g.allowed_roles,
  g.default_profile_id, g.max_profile_id, g.mfa_required, g.approval_required, g.approval_ttl_minutes,
  g.ip_allowlist::text[] AS ip_allowlist`;

/** The policy for one endpoint (null when the endpoint does not exist in this organization). */
export async function effectivePolicy(db: Db, orgId: string, endpointId: string): Promise<EffectivePolicy | null> {
  await ensureBuiltinProfiles(db, orgId);
  const r = await db.query<
    { endpoint_policy: EndpointPolicy | null; timezone: string | null } & Partial<Pick<FleetGroup, keyof FleetAccessPolicy | 'id' | 'name'>> & { group_id: string | null }
  >(
    `SELECT e.policy AS endpoint_policy, s.timezone, g.id AS group_id, ${GROUP_POLICY_COLUMNS.replace('g.id, ', '')}
       FROM endpoints e
       JOIN sites s ON s.organization_id = e.organization_id AND s.id = e.site_id
       LEFT JOIN fleet_groups g ON g.organization_id = e.organization_id AND g.id = e.fleet_group_id
      WHERE e.id = $1`,
    [endpointId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const timezone = safeTimeZone(row.timezone);
  if (row.group_id) {
    return {
      source: 'group',
      group: { id: row.group_id, name: row.name! },
      timezone,
      policy: {
        access_mode: row.access_mode!,
        consent_timeout_s: row.consent_timeout_s!,
        refuse_window_s: row.refuse_window_s!,
        allowed_hours: row.allowed_hours!,
        allowed_roles: row.allowed_roles!,
        default_profile_id: row.default_profile_id!,
        max_profile_id: row.max_profile_id!,
        mfa_required: row.mfa_required!,
        approval_required: row.approval_required!,
        approval_ttl_minutes: row.approval_ttl_minutes!,
        ip_allowlist: row.ip_allowlist!,
      },
    };
  }
  const support = await builtinProfile(db, 'support');
  const full = await builtinProfile(db, 'full_admin');
  return {
    source: 'organization_default',
    group: null,
    timezone,
    policy: {
      access_mode: row.endpoint_policy?.remote_desktop_consent === 'prompt' ? 'attended' : 'unattended',
      consent_timeout_s: 60,
      refuse_window_s: 0,
      allowed_hours: [],
      allowed_roles: ['owner', 'admin', 'technician'],
      default_profile_id: support.id,
      max_profile_id: full.id,
      mfa_required: false,
      approval_required: false,
      approval_ttl_minutes: 15,
      ip_allowlist: [],
    },
  };
}

/** The request address as one plain address (an IPv4-mapped IPv6 address becomes the IPv4 one). */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  try {
    return ipaddr.process(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '')).toString();
  } catch {
    return null;
  }
}

export function ipAllowed(list: string[], ip: string | null): boolean {
  if (list.length === 0) return true;
  if (!ip) return false;
  return list.some((cidr) => cidrContains(cidr, ip));
}

export function withinHours(policy: Pick<FleetAccessPolicy, 'allowed_hours'>, now: Date, timezone: string): boolean {
  if (policy.allowed_hours.length === 0) return true;
  return windowState(policy.allowed_hours, now, timezone).active;
}

export interface PolicyInput {
  policy: FleetAccessPolicy;
  timezone: string;
  role: Role;
  requestIp: string | null;
  now: Date;
  /** The operator has a TOTP authenticator. */
  operatorHasMfa: boolean;
  /** What the step-up token check said (absent: no token sent). */
  stepUp: 'valid' | 'invalid' | 'absent';
  requested: FleetPermissionProfile;
  max: FleetPermissionProfile;
}

export type PolicyOutcome =
  | {
      ok: true;
      trail: FleetPolicyTrailItem[];
      permissions: FleetPermissions;
      /** Flags of the requested profile that the maximum removed. */
      clamped: FleetPermissionKey[];
      attended: boolean;
      refuseWindowS: number;
      approvalNeeded: boolean;
      mfaVerified: boolean;
    }
  | { ok: false; code: RefusalCode; message: string; trail: FleetPolicyTrailItem[] };

export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const { policy } = input;
  const trail: FleetPolicyTrailItem[] = [];
  const refuse = (code: RefusalCode, check: string, detail: string): PolicyOutcome => {
    trail.push({ check, result: 'fail', detail });
    return { ok: false, code, message: REFUSAL_MESSAGES[code], trail };
  };

  if (input.role === 'viewer' || !policy.allowed_roles.includes(input.role as FleetAccessPolicy['allowed_roles'][number])) {
    return refuse('policy_role_not_allowed', 'role', `${input.role} not in ${policy.allowed_roles.join(', ')}`);
  }
  trail.push({ check: 'role', result: 'pass', detail: input.role });

  if (!ipAllowed(policy.ip_allowlist, input.requestIp)) {
    return refuse('policy_ip_not_allowed', 'ip', `${input.requestIp ?? 'unknown address'} not in ${policy.ip_allowlist.join(', ')}`);
  }
  trail.push({ check: 'ip', result: 'pass', detail: policy.ip_allowlist.length ? `${input.requestIp} allowed` : 'any address' });

  if (!withinHours(policy, input.now, input.timezone)) {
    return refuse('policy_outside_hours', 'hours', `outside the allowed hours (${input.timezone})`);
  }
  trail.push({ check: 'hours', result: 'pass', detail: policy.allowed_hours.length ? `inside the allowed hours (${input.timezone})` : 'any time' });

  let mfaVerified = false;
  if (policy.mfa_required) {
    if (!input.operatorHasMfa) return refuse('policy_mfa_not_enrolled', 'mfa', 'no authenticator set up');
    if (input.stepUp === 'absent') return refuse('policy_mfa_required', 'mfa', 'no verification sent');
    if (input.stepUp === 'invalid') return refuse('policy_mfa_invalid', 'mfa', 'verification expired or not valid');
    mfaVerified = true;
    trail.push({ check: 'mfa', result: 'pass', detail: 'verified (step-up)' });
  } else {
    trail.push({ check: 'mfa', result: 'info', detail: 'not required' });
  }

  const requested = permissionsOf(input.requested);
  const max = permissionsOf(input.max);
  const clamped = exceeding(requested, max);
  const permissions = clampPermissions(requested, max);
  if (!permissions.view) return refuse('profile_no_view', 'profile', `${input.requested.name} cannot see the screen`);
  trail.push({
    check: 'profile',
    result: 'pass',
    detail: clamped.length ? `${input.requested.name}, limited by ${input.max.name} (removed: ${clamped.join(', ')})` : input.requested.name,
  });

  const attended = policy.access_mode === 'attended';
  const approvalNeeded = !attended && policy.approval_required;
  trail.push({
    check: 'mode',
    result: 'info',
    detail: attended
      ? `attended: the user accepts within ${policy.consent_timeout_s} s`
      : policy.refuse_window_s > 0
        ? `unattended: the user may refuse within ${policy.refuse_window_s} s`
        : 'unattended',
  });
  if (approvalNeeded) trail.push({ check: 'approval', result: 'info', detail: `a second admin approves (expires after ${policy.approval_ttl_minutes} min)` });
  return { ok: true, trail, permissions, clamped, attended, refuseWindowS: attended ? 0 : policy.refuse_window_s, approvalNeeded, mfaVerified };
}

/** The profiles an operator may pick under a policy (each within its maximum). */
export function pickableProfiles(all: FleetPermissionProfile[], max: FleetPermissionProfile): FleetPermissionProfile[] {
  const m = permissionsOf(max);
  return all.filter((p) => exceeding(permissionsOf(p), m).length === 0);
}

export async function loadProfiles(db: Db, policy: FleetAccessPolicy, requestedId: string | undefined): Promise<{ requested: FleetPermissionProfile | null; max: FleetPermissionProfile }> {
  const max = await profileById(db, policy.max_profile_id);
  if (!max) throw new Error('policy maximum profile missing');
  const requested = await profileById(db, requestedId ?? policy.default_profile_id);
  return { requested, max };
}
