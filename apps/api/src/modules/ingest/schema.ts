import { z } from 'zod';
import { isIPv4 } from '../../common/net.ts';

// Collector protocol v1 — every field a collector can send is validated here.
// `.strict()` everywhere: unknown fields are rejected rather than silently stored.

const ipv4 = z.string().max(15).refine(isIPv4, 'must be an IPv4 address');
const mac = z.string().regex(/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/, 'must be a MAC address');
const timestamp = z.iso.datetime({ offset: true });
// eslint-disable-next-line no-control-regex
const text = z.string().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');

export const enrollSchema = z
  .object({
    enrollment_token: z.string().min(20).max(200),
    hostname: z.string().max(253),
    version: z.string().max(40),
    os: z.string().max(40),
    arch: z.string().max(40),
  })
  .strict();

export const heartbeatSchema = z
  .object({
    version: z.string().max(40),
    hostname: z.string().max(253),
    os: z.string().max(40),
    arch: z.string().max(40),
    uptime_seconds: z.number().int().min(0),
    gateway_ip: ipv4.optional(),
    interfaces: z
      .array(z.object({ name: z.string().max(120), addresses: z.array(z.string().max(64)).max(16) }).strict())
      .max(32)
      .default([]),
    spool_depth: z.number().int().min(0).max(1_000_000),
    completed_commands: z.array(z.uuid()).max(50).default([]),
  })
  .strict();

const hostSchema = z
  .object({
    ip: ipv4,
    mac: mac.optional(),
    hostname: z.string().min(1).max(253).optional(),
    rtt_ms: z.number().min(0).max(60_000).optional(),
    // How this host was observed. 'icmp' = echo reply, 'arp_cache' = present in the collector host's
    // neighbour table after probing, 'rdns' = a PTR record exists.
    // 'local_interface' = the collector host's own address and MAC, read from its own network interface.
    // 'mdns' / 'ssdp' / 'netbios' = it answered that discovery protocol; 'dhcp' = its own DHCP request was overheard.
    sources: z.array(z.enum(['icmp', 'arp_cache', 'rdns', 'local_interface', 'mdns', 'ssdp', 'netbios', 'dhcp'])).min(1).max(8),
    // What the device announced about itself. Device-supplied text: bounded here, escaped by the UI.
    names: z.array(z.object({ source: z.enum(['mdns', 'ssdp', 'netbios', 'dhcp']), name: text }).strict()).max(8).optional(),
    services: z.array(z.string().min(1).max(100)).max(40).optional(),
    hints: z.record(z.string().max(40), text).refine((h) => Object.keys(h).length <= 12, 'too many hints').optional(),
    ssdp: z
      .object({ server: text.optional(), friendly_name: text.optional(), manufacturer: text.optional(), model: text.optional(), device_types: z.array(z.string().max(60)).max(8).optional() })
      .strict()
      .optional(),
  })
  .strict();

const discoveryRunSchema = z
  .object({
    type: z.literal('discovery_run'),
    run_id: z.uuid(),
    scope_id: z.uuid(),
    trigger: z.enum(['scheduled', 'manual']),
    started_at: timestamp,
    finished_at: timestamp,
    hosts_probed: z.number().int().min(0).max(65_536),
    hosts: z.array(hostSchema).max(4096),
  })
  .strict();

const checkResultSchema = z
  .object({
    type: z.literal('check_result'),
    check_id: z.uuid(),
    ts: timestamp,
    ok: z.boolean(),
    latency_ms: z.number().min(0).max(120_000).optional(),
    loss_pct: z.number().min(0).max(100).optional(),
    jitter_ms: z.number().min(0).max(120_000).optional(),
    error: z.string().max(300).optional(),
    resolved_target: z.string().max(253).optional(),
  })
  .strict();

export const telemetryBatchSchema = z
  .object({
    batch_id: z.uuid(),
    sent_at: timestamp,
    items: z.array(z.discriminatedUnion('type', [discoveryRunSchema, checkResultSchema])).min(1).max(500),
  })
  .strict();

export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type DiscoveryRunItem = z.infer<typeof discoveryRunSchema>;
export type CheckResultItem = z.infer<typeof checkResultSchema>;
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;

export interface CollectorContext {
  id: string;
  organizationId: string;
  siteId: string;
  name: string;
  connectionState: 'never' | 'online' | 'offline';
  gatewayIp: string | null;
  os: string | null;
  hostname: string | null;
}

/** A single telemetry item was refused; the rest of the batch is still processed. */
export class ItemRejected extends Error {}

/** Collector clocks drift. Accept a little future skew, reject anything beyond it. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
