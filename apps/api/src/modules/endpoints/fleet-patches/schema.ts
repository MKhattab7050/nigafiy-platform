import { z } from 'zod';
/* eslint-disable no-control-regex -- the patterns refuse control characters */

export const PATCH_CLASSES = ['critical', 'security', 'definition', 'update_rollup', 'service_pack', 'feature_pack', 'update', 'driver', 'tool', 'upgrade', 'other'] as const;

// Text from the updater: control characters become spaces (titles come from Microsoft, apt, dnf).
const agentText = (max: number) => z.string().max(max * 2).transform((s) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max));

const agentUpdate = z
  .object({
    update_id: z.string().min(1).max(200).regex(/^[^\s\u0000-\u001f]([^\u0000-\u001f]*[^\s\u0000-\u001f])?$/, 'invalid update id'),
    title: agentText(500),
    kb: z.string().regex(/^KB\d{1,10}$/).optional(),
    classification: z.enum(PATCH_CLASSES),
    severity: agentText(40).optional(),
    size_bytes: z.number().int().min(0).max(1e13).optional(),
    reboot_required: z.boolean().optional(),
    published_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

/** POST /api/v1/agent/patch-status: one scan (internal/patch in the agent). */
export const agentPatchStatusSchema = z
  .object({
    source: z.enum(['wua', 'apt', 'dnf', 'softwareupdate', 'none']),
    install_supported: z.boolean(),
    scanned_at: z.iso.datetime({ offset: true }),
    scan_error: agentText(500).optional(),
    reboot_pending: z.boolean().optional(),
    updates: z.array(agentUpdate).max(1000),
  })
  .strict();
export type AgentPatchStatus = z.infer<typeof agentPatchStatusSchema>;

/** What the agent answers to patch_install. */
export const installResultSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            update_id: z.string().min(1).max(200),
            result: z.enum(['succeeded', 'failed', 'aborted', 'not_started']),
            hresult: z.string().max(200).optional(),
            reboot_required: z.boolean().optional(),
          })
          .strict(),
      )
      .max(200)
      .nullable()
      .default([]),
    reboot_required: z.boolean().default(false),
    output: z.string().max(8000).optional(),
  })
  .loose();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

/** PUT /fleet/patches/policies: the organization default (fleet_group_id null) or one group's. */
export const patchPolicySchema = z
  .object({
    fleet_group_id: z.uuid().nullable(),
    enabled: z.boolean(),
    auto_approve: z.array(z.enum(PATCH_CLASSES)).max(PATCH_CLASSES.length).transform((a) => [...new Set(a)]),
    window_kind: z.enum(['maintenance', 'group']),
    window_weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable().default(null),
    window_start: hhmm.nullable().default(null),
    window_minutes: z.number().int().min(30).max(720).nullable().default(null),
    window_timezone: z.string().min(1).max(64).nullable().default(null),
    reboot_policy: z.enum(['never', 'ask', 'force']),
    max_postponements: z.number().int().min(0).max(10).default(3),
    postpone_minutes: z.number().int().min(15).max(1440).default(60),
    reboot_deadline_hours: z.number().int().min(1).max(168).default(24),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.window_kind !== 'group') return;
    for (const k of ['window_weekdays', 'window_start', 'window_minutes', 'window_timezone'] as const) {
      if (p[k] === null) ctx.addIssue({ code: 'custom', path: [k], message: 'required for a group patch window' });
    }
    if (p.window_timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: p.window_timezone });
      } catch {
        ctx.addIssue({ code: 'custom', path: ['window_timezone'], message: 'unknown time zone' });
      }
    }
  })
  .transform((p) => {
    if (p.window_kind === 'maintenance') return { ...p, window_weekdays: null, window_start: null, window_minutes: null, window_timezone: null };
    return { ...p, window_weekdays: [...new Set(p.window_weekdays)].sort() };
  });
export type PatchPolicyInput = z.infer<typeof patchPolicySchema>;

/** POST /fleet/patches/approvals: an admin's decision on one update (every group, or one). */
export const patchApprovalSchema = z
  .object({
    update_id: z.string().min(1).max(200),
    fleet_group_id: z.uuid().nullable().default(null),
    decision: z.enum(['approved', 'declined']),
  })
  .strict();

export const patchInstallsQuery = z
  .object({
    endpoint_id: z.uuid().optional(),
    open: z.enum(['1', '0']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export const groupIdParams = z.object({ groupId: z.uuid() }).strict();
