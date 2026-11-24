import ipaddr from 'ipaddr.js';
import { z } from 'zod';

// Request schemas of Fleet permission profiles, groups, access policy, MFA step-up and approvals.

const flag = z.boolean();

/** Every flag of a profile (FLEET_PERMISSION_KEYS). */
const permissionFields = {
  view: flag,
  control: flag,
  clipboard_in: flag,
  clipboard_out: flag,
  files: flag,
  audio: flag,
  record: flag,
  restart: flag,
  privacy_screen: flag,
  block_input: flag,
  shell: flag,
};

const profileName = z.string().trim().min(1).max(60);
const description = z.string().trim().max(300).nullable();

export const profileCreateSchema = z
  .object({
    name: profileName,
    description: description.optional().default(null),
    view: flag.default(true),
    control: flag.default(false),
    clipboard_in: flag.default(false),
    clipboard_out: flag.default(false),
    files: flag.default(false),
    audio: flag.default(false),
    record: flag.default(false),
    restart: flag.default(false),
    privacy_screen: flag.default(false),
    block_input: flag.default(false),
    shell: flag.default(false),
  })
  .strict();
export type ProfileCreate = z.infer<typeof profileCreateSchema>;

export const profilePatchSchema = z
  .object({ name: profileName, description, ...permissionFields })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const hoursWindowSchema = z
  .object({
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .transform((d) => [...new Set(d)].sort()),
    start: z.string().regex(HHMM, 'Use HH:MM (24 h)'),
    end: z.string().regex(HHMM, 'Use HH:MM (24 h)'),
  })
  .strict()
  .refine((w) => w.start !== w.end, 'A window needs different start and end times');

/** A CIDR (or a single address, taken as /32 or /128), stored as its network address. */
export const cidrSchema = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .transform((value, ctx) => {
    try {
      const withPrefix = value.includes('/') ? value : `${value}/${ipaddr.parse(value).kind() === 'ipv6' ? 128 : 32}`;
      const [addr, bits] = ipaddr.parseCIDR(withPrefix);
      const network = addr.kind() === 'ipv4' ? ipaddr.IPv4.networkAddressFromCIDR(withPrefix) : ipaddr.IPv6.networkAddressFromCIDR(withPrefix);
      return `${network.toString()}/${bits}`;
    } catch {
      ctx.addIssue({ code: 'custom', message: `Not an IP range: ${value.slice(0, 50)} (example: 10.0.0.0/24, 192.168.1.20, fd00::/64)` });
      return z.NEVER;
    }
  });

const operatorRole = z.enum(['owner', 'admin', 'technician']);

const policyFields = {
  access_mode: z.enum(['attended', 'unattended']),
  consent_timeout_s: z.number().int().min(10).max(300),
  refuse_window_s: z.union([z.literal(0), z.number().int().min(10).max(300)]),
  allowed_hours: z.array(hoursWindowSchema).max(14),
  allowed_roles: z
    .array(operatorRole)
    .min(1)
    .max(3)
    .transform((r) => [...new Set(r)]),
  default_profile_id: z.uuid(),
  max_profile_id: z.uuid(),
  mfa_required: z.boolean(),
  approval_required: z.boolean(),
  approval_ttl_minutes: z.number().int().min(1).max(240),
  ip_allowlist: z
    .array(cidrSchema)
    .max(32)
    .transform((r) => [...new Set(r)]),
  // Session recording (migration 036).
  recording_mode: z.enum(['off', 'optional', 'required']),
  recording_retention_days: z.number().int().min(1).max(3650),
  user_may_view_recordings: z.boolean(),
};

const groupName = z.string().trim().min(1).max(80);
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #6B3FC7')
  .nullable();

export const groupCreateSchema = z
  .object({
    name: groupName,
    description: description.optional().default(null),
    color: color.optional().default(null),
    access_mode: policyFields.access_mode.default('attended'),
    consent_timeout_s: policyFields.consent_timeout_s.default(60),
    refuse_window_s: policyFields.refuse_window_s.default(0),
    allowed_hours: policyFields.allowed_hours.default([]),
    allowed_roles: policyFields.allowed_roles.default(['owner', 'admin', 'technician']),
    // Default: the Support built-in; maximum: Full admin.
    default_profile_id: policyFields.default_profile_id.optional(),
    max_profile_id: policyFields.max_profile_id.optional(),
    mfa_required: policyFields.mfa_required.default(false),
    approval_required: policyFields.approval_required.default(false),
    approval_ttl_minutes: policyFields.approval_ttl_minutes.default(15),
    ip_allowlist: policyFields.ip_allowlist.default([]),
    recording_mode: policyFields.recording_mode.default('optional'),
    recording_retention_days: policyFields.recording_retention_days.default(30),
    user_may_view_recordings: policyFields.user_may_view_recordings.default(false),
  })
  .strict();
export type GroupCreate = z.infer<typeof groupCreateSchema>;

export const groupPatchSchema = z
  .object({ name: groupName, description, color, ...policyFields })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');
export type GroupPatch = z.infer<typeof groupPatchSchema>;

/** POST /fleet/groups/assign: put endpoints in a group (null: take them out of any group). */
export const groupAssignSchema = z
  .object({
    endpoint_ids: z
      .array(z.uuid())
      .min(1)
      .max(500)
      .transform((ids) => [...new Set(ids)]),
    fleet_group_id: z.uuid().nullable(),
  })
  .strict();

/** POST /fleet/step-up */
export const stepUpSchema = z.object({ code: z.string().trim().min(6).max(12) }).strict();

/** POST /fleet/approvals/:id/approve | deny */
export const approvalDecisionSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();

export const approvalListQuery = z
  .object({
    state: z.enum(['pending', 'decided']).default('pending'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
