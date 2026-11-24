import { z } from 'zod';
import { timeZoneSchema } from '../../../common/timezone.ts';
import { scriptParamsSchema } from './params.ts';

// Fleet Pro: scripts library and jobs (migration 042). Requests are strict; values of parameters
// are checked against the script version's declaration in params.ts.

const scriptName = z.string().trim().min(1).max(120);
const scriptBody = z
  .string()
  .min(1)
  .max(100_000)
  .refine((b) => !b.includes('\0'), 'The script must not contain a NUL character')
  .refine((b) => b.trim().length > 0, 'The script is empty');

export const scriptCreateSchema = z
  .object({
    name: scriptName,
    description: z.string().trim().max(1000).nullable().default(null),
    os: z.enum(['windows', 'linux', 'macos']),
    technician_runnable: z.boolean().default(false),
    body: scriptBody,
    parameters: scriptParamsSchema.default([]),
    timeout_s: z.number().int().min(10).max(86_400).default(600),
    note: z.string().trim().max(300).nullable().default(null),
  })
  .strict();
export type ScriptCreate = z.infer<typeof scriptCreateSchema>;

/** Metadata changes keep the version; a new body, parameters or timeout make a new version. */
export const scriptPatchSchema = z
  .object({
    name: scriptName,
    description: z.string().trim().max(1000).nullable(),
    technician_runnable: z.boolean(),
    body: scriptBody,
    parameters: scriptParamsSchema,
    timeout_s: z.number().int().min(10).max(86_400),
    note: z.string().trim().max(300).nullable(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');
export type ScriptPatch = z.infer<typeof scriptPatchSchema>;

export const scriptListQuery = z
  .object({
    os: z.enum(['windows', 'linux', 'macos']).optional(),
    archived: z.enum(['true', 'false']).default('false'),
  })
  .strict();

const paramValue = z.union([z.string().max(4000), z.number(), z.boolean()]);

export const jobCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    script_id: z.uuid(),
    /** Defaults to the script's current version. */
    script_version: z.number().int().min(1).optional(),
    parameters: z.record(z.string().max(40), paramValue).default({}),
    target: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('endpoints'),
          endpoint_ids: z
            .array(z.uuid())
            .min(1)
            .max(1000)
            .transform((ids) => [...new Set(ids)]),
        })
        .strict(),
      z.object({ kind: z.literal('group'), fleet_group_id: z.uuid() }).strict(),
    ]),
    schedule: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('now') }).strict(),
      z.object({ kind: z.literal('once'), run_at: z.iso.datetime({ offset: true }) }).strict(),
      z
        .object({
          kind: z.literal('recurring'),
          every: z.enum(['hourly', 'daily', 'weekly', 'monthly']),
          time: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use HH:MM (24 hours)'),
          weekdays: z
            .array(z.number().int().min(0).max(6))
            .min(1)
            .max(7)
            .transform((d) => [...new Set(d)].sort())
            .optional(),
          monthday: z.number().int().min(1).max(28).optional(),
        })
        .strict()
        .superRefine((s, ctx) => {
          if (s.every === 'weekly' && !s.weekdays?.length) ctx.addIssue({ code: 'custom', message: 'A weekly job needs its weekdays' });
          if (s.every === 'monthly' && !s.monthday) ctx.addIssue({ code: 'custom', message: 'A monthly job needs its day of the month (1–28)' });
        }),
    ]),
    /** IANA zone of the schedule; defaults to the site's zone of the first target. */
    timezone: timeZoneSchema.optional(),
    maintenance_only: z.boolean().default(false),
    expiry_minutes: z.number().int().min(5).max(43_200).default(1440),
  })
  .strict();
export type JobCreate = z.infer<typeof jobCreateSchema>;

export const jobListQuery = z
  .object({
    state: z.enum(['active', 'paused', 'cancelled', 'finished']).optional(),
    endpoint_id: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const jobPauseSchema = z.object({ paused: z.boolean() }).strict();

export const outputParams = z.object({ id: z.uuid(), resultId: z.uuid() });
export const outputQuery = z.object({ stream: z.enum(['stdout', 'stderr']).default('stdout') }).strict();
