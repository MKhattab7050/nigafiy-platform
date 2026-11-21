import { z } from 'zod';
import { credentials } from '../credentials.ts';

/** A port change not answered by the collector within this time expires (it is never run late). */
export const PORT_REQUEST_TTL_MINUTES = 10;
/** ifAlias is a DisplayString of at most 64 characters (IF-MIB). */
export const MAX_ALIAS_LENGTH = 64;

const vlan = z.number().int().min(1).max(4094);
// Printable ASCII only: what every switch accepts in ifAlias.
const alias = z
  .string()
  .max(MAX_ALIAS_LENGTH)
  .regex(/^[\x20-\x7e]*$/, 'printable ASCII characters only')
  .transform((s) => s.trim());
/** Why the administrator proceeds although the port looks like an uplink / trunk / the collector's own path. */
const overrideReason = z.string().trim().min(10, 'explain in at least 10 characters why this port may be changed').max(500);
/** Explicit confirmation: the UI sends it only after the administrator confirmed the change. */
const confirm = z.literal(true, { error: 'confirm the change explicitly' });

export const portParams = z.object({ id: z.uuid(), ifIndex: z.coerce.number().int().min(1).max(2_147_483_647) });

export const portActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('admin_status'), admin_up: z.boolean(), override_reason: overrideReason.optional(), confirm }).strict(),
  z.object({ op: z.literal('alias'), alias, confirm }).strict(),
  z.object({ op: z.literal('access_vlan'), vlan, override_reason: overrideReason.optional(), confirm }).strict(),
]);
export type PortAction = z.infer<typeof portActionSchema>;
export type PortChange = { op: 'admin_status'; admin_up: boolean } | { op: 'alias'; alias: string } | { op: 'access_vlan'; vlan: number };

export const writeCredentialsSchema = z.object({ credentials }).strict();
export const quarantineVlanSchema = z.object({ vlan: vlan.nullable() }).strict();
export const sitePortControlSchema = z.object({ quarantine_vlan: vlan.nullable() }).strict();

export const requestListQuery = z.object({
  target_id: z.uuid().optional(),
  device_id: z.uuid().optional(),
  if_index: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const quarantineSchema = z.object({ reason: z.string().trim().max(500).optional(), confirm }).strict();
export const releaseSchema = z.object({ confirm }).strict();
