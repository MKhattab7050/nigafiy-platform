import { z } from 'zod';
import { DEVICE_TRUSTS, DEVICE_TYPES } from '@lan-detective/shared-types';
import { timeZoneSchema } from '../../common/timezone.ts';
import { TOOL_KINDS } from '../toolbox/index.ts';
import { CONDITION_TESTS, INCIDENT_KINDS, TRIGGER_EVENT_TYPES } from './catalog.ts';

const SEVERITIES = ['info', 'warning', 'critical'] as const;
const CHECK_ROLES = ['gateway', 'internet', 'dns', 'service'] as const;
const CHECK_STATES = ['unknown', 'ok', 'degraded', 'down'] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── triggers ──────────────────────────────────────────────────────────────────

export const eventTriggerSchema = z
  .object({
    kind: z.literal('event'),
    event_types: z.array(z.enum(TRIGGER_EVENT_TYPES)).min(1).max(10),
    filters: z
      .object({
        severities: z.array(z.enum(SEVERITIES)).max(3).optional(),
        device_trust: z.array(z.enum(DEVICE_TRUSTS)).max(3).optional(),
        device_types: z.array(z.enum(DEVICE_TYPES)).max(30).optional(),
        critical_only: z.boolean().optional(),
        check_ids: z.array(z.uuid()).max(50).optional(),
        check_roles: z.array(z.enum(CHECK_ROLES)).max(4).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export const incidentTriggerSchema = z
  .object({
    kind: z.literal('incident'),
    on: z.enum(['opened', 'resolved']),
    incident_kinds: z.array(z.enum(INCIDENT_KINDS)).max(4).optional(),
    severities: z.array(z.enum(SEVERITIES)).max(3).optional(),
  })
  .strict();

export const scheduleTriggerSchema = z
  .object({
    kind: z.literal('schedule'),
    every_minutes: z.number().int().min(5).max(1440).optional(),
    daily_at: z.string().regex(HHMM, 'Use HH:MM (24-hour)').optional(),
    /** Zone for daily_at. Defaults to the playbook site's zone (UTC for an organization-wide playbook). */
    timezone: timeZoneSchema.optional(),
  })
  .strict()
  .refine((t) => (t.every_minutes === undefined) !== (t.daily_at === undefined), 'Give either every_minutes or daily_at');

export const manualTriggerSchema = z.object({ kind: z.literal('manual') }).strict();

export const triggerSchema = z.union([eventTriggerSchema, incidentTriggerSchema, scheduleTriggerSchema, manualTriggerSchema]);
export type Trigger = z.infer<typeof triggerSchema>;
export type EventTrigger = z.infer<typeof eventTriggerSchema>;
export type IncidentTrigger = z.infer<typeof incidentTriggerSchema>;
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;

// ── steps ─────────────────────────────────────────────────────────────────────

const stepBase = {
  key: z.string().trim().regex(/^[a-z0-9_-]{1,32}$/i, 'Step key: letters, digits, _ or -').optional(),
  label: z.string().trim().max(120).optional(),
  on_error: z.enum(['stop', 'continue']).default('stop'),
};
/** null / absent: the trigger's device (or the device chosen for a manual run). */
const deviceParam = { device_id: z.uuid().nullable().default(null) };
const routerParam = { router_id: z.uuid().nullable().default(null) };

export const stepSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...stepBase,
      action: z.literal('notify'),
      params: z
        .object({
          channel_ids: z.array(z.uuid()).max(10).default([]),
          severity: z.enum(SEVERITIES).default('info'),
          title: z.string().trim().min(1).max(200),
          message: z.string().trim().max(2000).default(''),
          attach: z.enum(['none', 'trigger', 'previous_output', 'site_summary']).default('trigger'),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...stepBase,
      action: z.literal('run_tool'),
      params: z
        .object({
          tool: z.enum(TOOL_KINDS),
          target: z.enum(['trigger_device', 'trigger_check', 'custom']).default('trigger_device'),
          custom_target: z.string().trim().min(1).max(253).optional(),
          port: z.number().int().min(1).max(65535).nullable().default(null),
          ...deviceParam,
        })
        .strict(),
    })
    .strict(),
  z.object({ ...stepBase, action: z.literal('run_checks'), params: z.object({}).strict().default({}) }).strict(),
  z.object({ ...stepBase, action: z.literal('run_discovery'), params: z.object({}).strict().default({}) }).strict(),
  z.object({ ...stepBase, action: z.literal('wake_device'), params: z.object({ ...deviceParam }).strict().default({ device_id: null }) }).strict(),
  z.object({ ...stepBase, action: z.literal('set_trust'), params: z.object({ trust: z.enum(DEVICE_TRUSTS), ...deviceParam }).strict() }).strict(),
  z
    .object({ ...stepBase, action: z.literal('dns_pause'), params: z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60), ...deviceParam }).strict() })
    .strict(),
  z.object({ ...stepBase, action: z.literal('dns_resume'), params: z.object({ ...deviceParam }).strict().default({ device_id: null }) }).strict(),
  z.object({ ...stepBase, action: z.literal('router_block'), params: z.object({ ...routerParam, ...deviceParam }).strict().default({ router_id: null, device_id: null }) }).strict(),
  z.object({ ...stepBase, action: z.literal('router_unblock'), params: z.object({ ...routerParam, ...deviceParam }).strict().default({ router_id: null, device_id: null }) }).strict(),
  z
    .object({
      ...stepBase,
      action: z.literal('router_rate_limit'),
      params: z
        .object({ ...routerParam, ...deviceParam, down_kbps: z.number().int().min(0).max(10_000_000), up_kbps: z.number().int().min(0).max(10_000_000) })
        .strict()
        .refine((p) => p.down_kbps > 0 || p.up_kbps > 0, 'Give a limit in at least one direction'),
    })
    .strict(),
  z
    .object({
      ...stepBase,
      action: z.literal('endpoint_command'),
      // `command` is validated by the endpoints module's own schema (parseAutomatableCommand) in service.ts.
      params: z.object({ command: z.record(z.string(), z.unknown()), endpoint_id: z.uuid().nullable().default(null), ...deviceParam }).strict(),
    })
    .strict(),
  z
    .object({
      ...stepBase,
      action: z.literal('incident_comment'),
      params: z.object({ body: z.string().trim().min(1).max(2000), include_previous_output: z.boolean().default(true) }).strict(),
    })
    .strict(),
  z.object({ ...stepBase, action: z.literal('incident_acknowledge'), params: z.object({}).strict().default({}) }).strict(),
  z.object({ ...stepBase, action: z.literal('wait'), params: z.object({ seconds: z.number().int().min(5).max(3600) }).strict() }).strict(),
  z
    .object({
      ...stepBase,
      action: z.literal('condition'),
      params: z
        .object({
          test: z.enum(CONDITION_TESTS),
          /** check_state: null = the trigger's check. */
          check_id: z.uuid().nullable().default(null),
          states: z.array(z.enum(CHECK_STATES)).min(1).max(4).optional(),
          ...deviceParam,
          /** When the test is true: continue or stop the run. When false, the opposite. */
          if_true: z.enum(['continue', 'stop']).default('continue'),
        })
        .strict()
        .refine((p) => p.test !== 'check_state' || (p.states && p.states.length > 0), 'Choose the check states to test for'),
    })
    .strict(),
  z
    .object({
      ...stepBase,
      action: z.literal('approval'),
      /** Shown to the approvers: what they are asked to confirm before the next steps run. */
      params: z.object({ message: z.string().trim().max(500).default('') }).strict().default({ message: '' }),
    })
    .strict(),
]);
export type StepInput = z.input<typeof stepSchema>;
export type Step = z.infer<typeof stepSchema> & { key: string };

// ── playbooks ─────────────────────────────────────────────────────────────────

const playbookFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
  site_id: z.uuid().nullable().default(null),
  enabled: z.boolean().default(false),
  dry_run: z.boolean().default(false),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(20),
  approval_mode: z.enum(['always_ask', 'run_automatically']).default('always_ask'),
  /** Required (true) to set or keep run_automatically when steps or trigger change: the explicit consent. */
  auto_run_confirmed: z.boolean().optional(),
  max_runs_per_hour: z.number().int().min(1).max(60).default(6),
};

export const playbookCreateSchema = z.object(playbookFields).strict();
export type PlaybookCreate = z.infer<typeof playbookCreateSchema>;

export const playbookPatchSchema = z
  .object({
    name: playbookFields.name,
    description: z.string().trim().max(2000),
    site_id: z.uuid().nullable(),
    enabled: z.boolean(),
    dry_run: z.boolean(),
    trigger: triggerSchema,
    steps: playbookFields.steps,
    approval_mode: z.enum(['always_ask', 'run_automatically']),
    auto_run_confirmed: z.boolean(),
    max_runs_per_hour: z.number().int().min(1).max(60),
  })
  .partial()
  .strict();
export type PlaybookPatch = z.infer<typeof playbookPatchSchema>;

export const fromTemplateSchema = z.object({ template: z.string().min(1).max(60), site_id: z.uuid().nullable().default(null) }).strict();

export const runNowSchema = z.object({ device_id: z.uuid().nullable().default(null), dry_run: z.boolean().default(false) }).strict();

export const decisionSchema = z
  .object({ decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(1000).optional() })
  .strict()
  .refine((d) => d.decision === 'approve' || (d.comment && d.comment.length >= 3), { message: 'Say why you reject it (at least 3 characters)', path: ['comment'] });

export const settingsSchema = z.object({ two_person_rule: z.boolean(), approval_ttl_minutes: z.number().int().min(5).max(1440) }).partial().strict();

export const runsQuery = z.object({
  playbook_id: z.uuid().optional(),
  status: z.enum(['active', 'finished', 'all']).default('all'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

export const listQuery = z.object({ site_id: z.uuid().optional() });

export const approvalsQuery = z.object({ page_size: z.coerce.number().int().min(1).max(100).default(50) });
