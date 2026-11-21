import { z } from 'zod';

export const automationListQuery = z.object({ site_id: z.uuid().optional() });

export const automationKeyParams = z.object({ key: z.string().min(1).max(80) });

/** `config` is validated against the key's own schema in the service (catalogue.ts). */
export const automationPutBody = z
  .object({
    site_id: z.uuid().nullable().optional(),
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const automationResetQuery = z.object({ site_id: z.uuid().optional() });
