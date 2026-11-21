import { z } from 'zod';

/** Router drivers shipped in the collector (collectors/lan-collector/internal/router/*). */
export const ROUTER_VENDORS = [
  'mikrotik',
  'huawei',
  'huawei_lte',
  'zte',
  'tplink_archer',
  'tenda',
  'dlink',
  'asus',
  'zyxel',
  'unifi',
  'omada',
  'openwrt',
  'opnsense',
  'pfsense',
  'fortigate',
  'cisco_xe',
] as const;
export const ROUTER_TRANSPORTS = ['https', 'https-pinned', 'http'] as const;
export const MAX_ROUTERS_PER_SITE = 16;
export const MAX_BULK_DEVICES = 50;
/** A router request not answered within this time expires (like a wake request). */
export const REQUEST_TTL_MINUTES = 10;
/** A router that locks the account without saying for how long: no login for this long. */
export const DEFAULT_LOCKOUT_MINUTES = 30;

export const routerCredentials = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(128),
  })
  .strict();
export type RouterCredentials = z.infer<typeof routerCredentials>;

export const routerListQuery = z.object({ site_id: z.uuid().optional() });

export const routerCreateSchema = z
  .object({
    site_id: z.uuid(),
    name: z.string().trim().min(1).max(80),
    vendor: z.enum(ROUTER_VENDORS),
    address: z.ipv4(),
    port: z.number().int().min(1).max(65535).nullable().default(null),
    // https-pinned without a pin: the router waits for a certificate the administrator confirms.
    transport: z.enum(ROUTER_TRANSPORTS).default('https-pinned'),
    credentials: routerCredentials,
    refresh_interval_seconds: z.number().int().min(120).max(86400).default(300),
    enabled: z.boolean().default(true),
  })
  .strict();
export type RouterCreate = z.infer<typeof routerCreateSchema>;

export const routerPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    port: z.number().int().min(1).max(65535).nullable(),
    transport: z.enum(ROUTER_TRANSPORTS),
    credentials: routerCredentials,
    refresh_interval_seconds: z.number().int().min(120).max(86400),
    enabled: z.boolean(),
  })
  .partial()
  .strict();
export type RouterPatch = z.infer<typeof routerPatchSchema>;

const PIN = /^[0-9A-Fa-f]{2}(:?[0-9A-Fa-f]{2}){31}$/;
export const certificateTrustSchema = z.object({ sha256: z.string().trim().regex(PIN, 'a SHA-256 fingerprint (64 hex digits)') }).strict();

/** Canonical pin form: colon-separated upper-case hex (what the collector reports). */
export function canonicalPin(pin: string): string {
  return pin.replaceAll(':', '').toUpperCase().match(/.{2}/g)!.join(':');
}

export const deviceIdsSchema = z.object({ device_ids: z.array(z.uuid()).min(1).max(MAX_BULK_DEVICES) }).strict();

export const rateLimitSchema = z
  .object({
    device_id: z.uuid(),
    // null: remove the limit.
    limit: z
      .object({ down_kbps: z.number().int().min(0).max(10_000_000), up_kbps: z.number().int().min(0).max(10_000_000) })
      .strict()
      .refine((l) => l.down_kbps > 0 || l.up_kbps > 0, 'give a limit in at least one direction')
      .nullable(),
  })
  .strict();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const scheduleSchema = z
  .object({
    device_id: z.uuid(),
    // Weekly windows during which the device is blocked, in the router's local time; null: remove.
    windows: z
      .array(z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: z.string().regex(HHMM), end: z.string().regex(HHMM) }).strict())
      .min(1)
      .max(8)
      .nullable(),
  })
  .strict();
