import { z } from 'zod';
import { timeZoneSchema } from '../../common/timezone.ts';

const LOCAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/;

export const localTimestampSchema = z
  .string()
  .trim()
  .regex(LOCAL_TIMESTAMP_RE, 'Enter a date and time (YYYY-MM-DDTHH:MM:SS)')
  .transform((s) => {
    // Strip trailing Z / offset if provided and normalize separator to 'T'
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(s);
    if (!match) return s;
    const timePart = match[2]!.length === 5 ? `${match[2]!}:00` : match[2]!;
    return `${match[1]!}T${timePart}`;
  });

export const maintenanceListQuery = z.object({
  site_id: z.uuid().optional(),
});

export const maintenanceCreateSchema = z
  .object({
    site_id: z.uuid().nullable().optional().default(null),
    reason: z.string().trim().min(1).max(500),
    timezone: timeZoneSchema.optional(),
    starts_local: localTimestampSchema,
    ends_local: localTimestampSchema,
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional().default(null),
    recur_until: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date (YYYY-MM-DD)')
      .nullable()
      .optional()
      .default(null),
    target_all: z.boolean().optional(),
    device_ids: z.array(z.uuid()).max(200).optional().default([]),
    check_ids: z.array(z.uuid()).max(200).optional().default([]),
    collector_ids: z.array(z.uuid()).max(200).optional().default([]),
  })
  .strict();

export type MaintenanceCreate = z.infer<typeof maintenanceCreateSchema>;

export const maintenancePatchSchema = z
  .object({
    site_id: z.uuid().nullable(),
    reason: z.string().trim().min(1).max(500),
    timezone: timeZoneSchema,
    starts_local: localTimestampSchema,
    ends_local: localTimestampSchema,
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).nullable(),
    recur_until: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date (YYYY-MM-DD)')
      .nullable(),
    target_all: z.boolean(),
    device_ids: z.array(z.uuid()).max(200),
    check_ids: z.array(z.uuid()).max(200),
    collector_ids: z.array(z.uuid()).max(200),
  })
  .partial()
  .strict();

export type MaintenancePatch = z.infer<typeof maintenancePatchSchema>;
