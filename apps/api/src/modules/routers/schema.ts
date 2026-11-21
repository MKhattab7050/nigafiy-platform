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
    // IANA time zone of the windows when LAN Detective enforces the schedule itself (default: the site's).
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

// Router controls beyond blocking (docs/features/router-controls.md). The collector re-checks every rule.

/** Ports the router itself is managed on (web UI, SSH, Telnet, TR-069): never forwarded. */
export const MANAGEMENT_PORTS = [22, 23, 80, 443, 7547] as const;
export const MAX_PORTS_PER_RULE = 1000;
export const PORT_FORWARD_PREFIX = 'LAN Detective: ';

// Control characters (C0, DEL, C1) are refused in anything written to the router.
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f]*$/;
const routerText = (max: number) => z.string().trim().min(1).max(max).regex(NO_CONTROL, 'control characters are not allowed');
const portNumber = z.number().int().min(1).max(65535);

export const renameSchema = z.object({ device_id: z.uuid(), name: routerText(63) }).strict();

export const wifiSchema = z
  .object({
    wifi_id: z.string().min(1).max(40),
    enabled: z.boolean(),
    // Required to turn off a main network: every device on it disconnects.
    confirm: z.boolean().optional(),
  })
  .strict();

export const reservationSchema = z.object({ device_id: z.uuid(), ip: z.ipv4() }).strict();

export const portForwardSchema = z
  .object({
    device_id: z.uuid(),
    description: routerText(60),
    protocol: z.enum(['tcp', 'udp', 'both']),
    external_start: portNumber,
    external_end: portNumber.optional(),
    internal_start: portNumber.optional(),
    internal_end: portNumber.optional(),
  })
  .strict();
export type PortForwardBody = z.infer<typeof portForwardSchema>;

export const rebootSchema = z.object({ confirm: z.literal('reboot') }).strict();

export const deviceParams = z.object({ id: z.uuid(), device_id: z.uuid() });
export const ruleParams = z.object({ id: z.uuid(), rule_id: z.string().min(1).max(40) });
/** DELETE /routers/:id/reservations/by-mac/:mac — a reservation whose MAC matches no device record. */
export const reservationMacParams = z.object({
  id: z.uuid(),
  mac: z
    .string()
    .regex(/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/, 'must be a MAC address such as aa:bb:cc:dd:ee:ff')
    .transform((v) => v.toLowerCase().replaceAll('-', ':')),
});
