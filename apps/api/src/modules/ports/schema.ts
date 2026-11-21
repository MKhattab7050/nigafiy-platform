import { z } from 'zod';
import { credentials } from './credentials.ts';

export const MAX_TARGETS_PER_SITE = 32;

export const switchListQuery = z.object({ site_id: z.uuid().optional() });

export const switchCreateSchema = z
  .object({
    site_id: z.uuid(),
    host: z.ipv4(),
    port: z.number().int().min(1).max(65535).default(161),
    name: z.string().trim().min(1).max(80).optional(),
    credentials,
  })
  .strict();
export type SwitchCreate = z.infer<typeof switchCreateSchema>;

export const switchPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).nullable().optional(),
    host: z.ipv4().optional(),
    enabled: z.boolean().optional(),
    poll_interval_seconds: z.number().int().min(60).max(86400).optional(),
    credentials: credentials.optional(),
  })
  .strict();
export type SwitchPatch = z.infer<typeof switchPatchSchema>;

export const portHistoryParams = z.object({ id: z.uuid(), ifIndex: z.coerce.number().int().min(0).max(2_147_483_647) });
export const portHistoryQuery = z.object({ range: z.enum(['6h', '24h', '7d', '30d']).default('24h') });
export type PortHistoryRange = z.infer<typeof portHistoryQuery>['range'];

export const portFindQuery = z.object({ q: z.string().trim().min(2).max(100), site_id: z.uuid().optional() });
