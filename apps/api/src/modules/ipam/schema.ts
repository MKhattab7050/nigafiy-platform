import { z } from 'zod';
import { canonicalIp, isIP, normalizeMac } from '../../common/net.ts';
import { MAX_ADDRESS_PAGE } from './facts.ts';

/**
 * An IPv4 or IPv6 host address, in canonical form (RFC 5952 for IPv6, as PostgreSQL's host() returns
 * it, so it compares equal to stored addresses). No zone index, no prefix length.
 */
const ip = z.string().trim().max(45).refine(isIP, 'Not a valid IPv4 or IPv6 address').transform(canonicalIp);

export const subnetListQuery = z.object({ site_id: z.uuid().optional() });

/** Which part of the address list (IPv6 subnets are paged: facts.ts loadSubnet). */
export const subnetDetailQuery = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ADDRESS_PAGE).optional(),
  ip: ip.optional(),
});

export const subnetBody = z
  .object({
    vlan_id: z.number().int().min(1).max(4094).nullable(),
    gateway: ip.nullable(),
    // A DNS server may be of either family whatever the subnet's family.
    dns_servers: z.array(ip).max(4),
    dhcp_start: ip.nullable(),
    dhcp_end: ip.nullable(),
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
export const createRecord = z.object({ site_id: z.uuid(), ip, ...recordFields }).strict();
export const patchRecord = z.object(recordFields).partial().strict();
export type CreateRecord = z.infer<typeof createRecord>;
export type PatchRecord = z.infer<typeof patchRecord>;

export const historyQuery = z.object({ site_id: z.uuid(), ip });
