import { z } from 'zod';
import { isIPv4 } from './net.ts';

// Collector protocol v1 — the `smart_check` telemetry item (modules/security). Kept in its own file
// so the shared collector-protocol.ts only gains one union member. `.strict()` everywhere.
//
// One item = one run of one check. Exactly the block that matches `check` is present.
// Everything a device or a nearby network said about itself (SSIDs, page titles, UPnP descriptions)
// is untrusted text: bounded and control-character-free here, escaped by the UI.

const ipv4 = z.string().max(15).refine(isIPv4, 'must be an IPv4 address');
const mac = z.string().regex(/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/, 'must be a MAC address');
const timestamp = z.iso.datetime({ offset: true });
// eslint-disable-next-line no-control-regex
const clean = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');

export const SMART_CHECKS = ['rogue_dhcp', 'upnp', 'wifi', 'banners', 'dhcp_fingerprints'] as const;
export type SmartCheckKind = (typeof SMART_CHECKS)[number];

export const SMART_ERROR_KINDS = ['listen_failed', 'no_interface', 'not_supported', 'command_failed', 'not_found', 'timeout', 'protocol', 'internal'] as const;

const dhcpOffer = z
  .object({
    server_id: ipv4,
    source_ip: ipv4,
    server_mac: mac.optional(),
    offered_ip: ipv4.optional(),
    subnet_mask: ipv4.optional(),
    routers: z.array(ipv4).max(8).default([]),
    dns: z.array(ipv4).max(8).default([]),
    lease_seconds: z.number().int().min(0).max(2 ** 32).optional(),
    domain: clean(120).optional(),
  })
  .strict();

const dhcpBlock = z
  .object({
    interfaces: z
      .array(
        z
          .object({
            name: clean(120),
            address: ipv4,
            mac: mac.optional(),
            scope_id: z.uuid().optional(),
            // Set when the DHCP client port could not be opened on this interface (nothing was sent).
            listen_error: clean(300).optional(),
            listen_seconds: z.number().min(0).max(60).optional(),
            offers: z.array(dhcpOffer).max(32),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

const upnpMapping = z
  .object({
    protocol: z.enum(['TCP', 'UDP']),
    external_port: z.number().int().min(0).max(65535),
    remote_host: clean(64).default(''),
    internal_client: ipv4,
    internal_port: z.number().int().min(0).max(65535),
    description: clean(120).optional(),
    enabled: z.boolean().default(true),
    lease_seconds: z.number().int().min(0).max(2 ** 32).optional(),
  })
  .strict();

const upnpBlock = z
  .object({
    gateways: z
      .array(
        z
          .object({
            address: ipv4,
            friendly_name: clean(120).optional(),
            manufacturer: clean(120).optional(),
            model: clean(120).optional(),
            service_type: clean(120).optional(),
            external_ip: ipv4.optional(),
            error: clean(300).optional(),
            mappings_truncated: z.boolean().default(false),
            mappings: z.array(upnpMapping).max(256),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

const wifiNetwork = z
  .object({
    ssid: clean(64).default(''),
    bssid: mac,
    channel: z.number().int().min(1).max(233).optional(),
    band: z.enum(['2.4', '5', '6']).optional(),
    frequency_mhz: z.number().int().min(2000).max(7200).optional(),
    signal_pct: z.number().int().min(0).max(100).optional(),
    rssi_dbm: z.number().int().min(-120).max(0).optional(),
    security: clean(60).optional(),
    auth: clean(60).optional(),
    cipher: clean(60).optional(),
  })
  .strict();

const wifiBlock = z
  .object({
    platform: z.enum(['windows', 'linux', 'darwin']),
    interface: clean(120).optional(),
    connected: z.boolean(),
    link: wifiNetwork
      .extend({
        rx_mbps: z.number().min(0).max(100_000).optional(),
        tx_mbps: z.number().min(0).max(100_000).optional(),
        phy: clean(40).optional(),
      })
      .strict()
      .optional(),
    networks: z.array(wifiNetwork).max(256),
    truncated: z.boolean().optional(),
  })
  .strict();

const banner = z
  .object({
    ip: ipv4,
    port: z.number().int().min(1).max(65535),
    scheme: z.enum(['http', 'https']),
    status: z.number().int().min(100).max(599).optional(),
    title: clean(120).optional(),
    server: clean(120).optional(),
    tls_subject: clean(300).optional(),
    tls_issuer: clean(300).optional(),
    tls_self_signed: z.boolean().optional(),
  })
  .strict();

const bannersBlock = z
  .object({
    // Every address that was probed (so "nothing answered" is recorded too), and what answered.
    probed: z.array(ipv4).max(64),
    results: z.array(banner).max(256),
  })
  .strict();

const fingerprintsBlock = z
  .object({
    clients: z
      .array(
        z
          .object({
            mac,
            // Option 55 as comma-separated decimal codes, in the order the client sent them.
            prl: z.string().max(400).regex(/^\d{1,3}(,\d{1,3})*$/, 'must be comma-separated option codes'),
            vendor_class: clean(120).optional(),
            hostname: clean(120).optional(),
            // Option 54 in the client's DHCPREQUEST: the server it chose.
            server_id: ipv4.optional(),
            seen_at: timestamp,
          })
          .strict(),
      )
      .max(1024),
  })
  .strict();

export const smartCheckSchema = z
  .object({
    type: z.literal('smart_check'),
    ts: timestamp,
    run_id: z.uuid(),
    check: z.enum(SMART_CHECKS),
    trigger: z.enum(['scheduled', 'manual']),
    ok: z.boolean(),
    duration_ms: z.number().int().min(0).max(3_600_000).optional(),
    error: z.object({ kind: z.enum(SMART_ERROR_KINDS), message: clean(400) }).strict().optional(),
    dhcp: dhcpBlock.optional(),
    upnp: upnpBlock.optional(),
    wifi: wifiBlock.optional(),
    banners: bannersBlock.optional(),
    dhcp_fingerprints: fingerprintsBlock.optional(),
  })
  .strict()
  .refine(
    (i) => {
      const blocks = { rogue_dhcp: i.dhcp, upnp: i.upnp, wifi: i.wifi, banners: i.banners, dhcp_fingerprints: i.dhcp_fingerprints };
      const present = Object.entries(blocks).filter(([, v]) => v !== undefined).map(([k]) => k);
      // A successful run carries its own block and nothing else; a failed run may carry partial data of its own kind only.
      return present.every((k) => k === i.check) && (!i.ok || present.length === 1);
    },
    { message: 'the data block must match the check' },
  );

export type SmartCheckItem = z.infer<typeof smartCheckSchema>;
