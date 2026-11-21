import { z } from 'zod';
import { isIPv4, normalizeMac } from '../../common/net.ts';

const ipv4 = z.string().trim().refine(isIPv4, 'Not a valid IPv4 address');

export const subnetListQuery = z.object({ site_id: z.uuid().optional() });

export const subnetBody = z
  .object({
    vlan_id: z.number().int().min(1).max(4094).nullable(),
    gateway: ipv4.nullable(),
    dns_servers: z.array(ipv4).max(4),
    dhcp_start: ipv4.nullable(),
    dhcp_end: ipv4.nullable(),
    notes: z.string().trim().max(1000).nullable(),
  })
  .strict();
export type SubnetBody = z.infer<typeof subnetBody>;

const mac = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/, 'Not a valid MAC address (example: 00:11:22:33:44:55)')
  .transform(normalizeMac);

const recordFields = {
  kind: z.enum(['static', 'dhcp_reservation', 'reserved']),
  label: z.string().trim().min(1).max(80),
  mac: mac.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
};
export const createRecord = z.object({ site_id: z.uuid(), ip: ipv4, ...recordFields }).strict();
export const patchRecord = z.object(recordFields).partial().strict();
export type CreateRecord = z.infer<typeof createRecord>;
export type PatchRecord = z.infer<typeof patchRecord>;

export const historyQuery = z.object({ site_id: z.uuid(), ip: ipv4 });
