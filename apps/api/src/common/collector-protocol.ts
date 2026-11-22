import { z } from 'zod';
import { canonicalIp, isIP, isIPv4 } from './net.ts';
import { configBackupProbeResultSchema, configBackupResultSchema, configRestoreResultSchema } from './config-backup-protocol.ts';
import { smartCheckSchema } from './smart-check-protocol.ts';
import { switchPortResultSchema, switchVlansSchema } from './switch-port-protocol.ts';

// Collector protocol v1 — every field a collector can send is validated here.
// Shared contract: the collector gateway (modules/ingest) validates with it, and the modules that
// process telemetry items (ingest, ports, toolbox) type their input with it.
// `.strict()` everywhere: unknown fields are rejected rather than silently stored.

const ipv4 = z.string().max(15).refine(isIPv4, 'must be an IPv4 address');
// IPv4 or IPv6 (no zone), in the canonical text form PostgreSQL's host() returns.
const ipAny = z.string().max(45).refine(isIP, 'must be an IPv4 or IPv6 address').transform(canonicalIp);
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
    access_status: z
      .object({
        enabled: z.boolean(),
        listening: z.boolean(),
        listen: z.string().max(64).optional(),
        error: z.string().max(400).optional(),
        upstreams: z.array(z.string().max(64)).max(8).optional(),
        lists: z.record(z.string().max(40), z.number().int().min(0)).optional(),
        list_error: z.string().max(400).optional(),
        // The zone schedules are evaluated in, and why the configured one could not be used.
        timezone: z.string().max(64).optional(),
        timezone_error: z.string().max(400).optional(),
      })
      .strict()
      .optional(),
    // The receive-only MikroTik neighbour listener (UDP 5678): whether it runs and what it received.
    mndp_status: z
      .object({
        state: z.enum(['listening', 'disabled', 'bind_failed', 'stopped']),
        listen: z.string().max(64).optional(),
        error: z.string().max(400).optional(),
        since: timestamp,
        received: z.number().int().min(0),
        malformed: z.number().int().min(0),
        out_of_scope: z.number().int().min(0),
        neighbors: z.number().int().min(0).max(100_000),
      })
      .strict()
      .optional(),
  })
  .strict();

const hostSchema = z
  .object({
    ip: ipAny,
    mac: mac.optional(),
    hostname: z.string().min(1).max(253).optional(),
    rtt_ms: z.number().min(0).max(60_000).optional(),
    // How this host was observed. 'icmp' = echo reply, 'arp_cache' = present in the collector host's
    // neighbour table after probing, 'rdns' = a PTR record exists.
    // 'local_interface' = the collector host's own address and MAC, read from its own network interface.
    // 'mdns' / 'ssdp' / 'netbios' = it answered that discovery protocol; 'dhcp' = its own DHCP request was overheard.
    // IPv6 (never swept, docs/features/ipv6.md): 'icmpv6_multicast' = it answered an echo request to the
    // all-nodes group ff02::1; 'icmpv6' = it answered a unicast echo; 'ndp_cache' = the collector host's
    // IPv6 neighbour table holds it (reachable, or with the MAC of a device that answered).
    sources: z.array(z.enum(['icmp', 'arp_cache', 'rdns', 'local_interface', 'mdns', 'ssdp', 'netbios', 'dhcp', 'icmpv6', 'icmpv6_multicast', 'ndp_cache'])).min(1).max(11),
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

const detailText = (max: number) => z.string().max(max);
const checkDetailsSchema = z
  .object({
    status_code: z.number().int().min(100).max(599).optional(),
    final_url: detailText(500).optional(),
    redirects: z.number().int().min(0).max(20).optional(),
    body_bytes: z.number().int().min(0).max(1_048_576).optional(),
    body_matched: z.boolean().optional(),
    tls_version: detailText(16).optional(),
    cert_subject: detailText(300).optional(),
    cert_issuer: detailText(300).optional(),
    cert_not_before: timestamp.optional(),
    cert_not_after: timestamp.optional(),
    cert_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    cert_dns_names: z.array(detailText(253)).max(20).optional(),
    verified: z.boolean().optional(),
    verify_error: detailText(300).optional(),
    oid: detailText(128).optional(),
    raw_value: detailText(120).optional(),
    ratio_raw: detailText(120).optional(),
    value_type: detailText(32).optional(),
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
    /** Watch checks: the measured value (TLS days remaining, the OID value, the HTTP status code). */
    value: z.number().min(-1e15).max(1e15).optional(),
    /** Watch checks: evidence of this sample (never the response body itself). */
    details: checkDetailsSchema.optional(),
  })
  .strict();

const dnsStatsSchema = z
  .object({
    type: z.literal('dns_stats'),
    ts: timestamp,
    window_start: timestamp,
    clients: z
      .array(
        z
          .object({
            ip: z.string().max(64),
            mac: z.string().max(17).optional(),
            queries: z.number().int().min(0).max(10_000_000),
            blocked: z.number().int().min(0).max(10_000_000),
            top_domains: z
              .array(
                z
                  .object({
                    domain: z.string().max(253),
                    count: z.number().int().min(0),
                    blocked: z.number().int().min(0),
                    reason: z.string().max(40).optional(),
                    category: z.string().max(40).optional(),
                  })
                  .strict(),
              )
              .max(50),
          })
          .strict(),
      )
      .max(512),
  })
  .strict();

const counter = z.number().min(0).max(1.9e19);
const snmpPollSchema = z
  .object({
    type: z.literal('snmp_poll'),
    ts: timestamp,
    target_id: z.uuid(),
    ok: z.boolean(),
    error: z.string().max(300).optional(),
    duration_ms: z.number().int().min(0).optional(),
    sys_name: z.string().max(120).optional(),
    sys_descr: z.string().max(300).optional(),
    ports: z
      .array(
        z
          .object({
            if_index: z.number().int().min(0).max(2_147_483_647),
            name: z.string().min(1).max(120),
            descr: z.string().max(120).optional(),
            alias: z.string().max(120).optional(),
            admin_up: z.boolean(),
            oper_up: z.boolean(),
            speed_mbps: z.number().int().min(0).max(10_000_000),
            in_errors: counter,
            out_errors: counter,
            in_discards: counter,
            out_discards: counter,
            in_octets: counter,
            out_octets: counter,
          })
          .strict(),
      )
      .max(1024)
      .optional(),
    fdb: z
      .array(z.object({ mac, if_index: z.number().int().min(1).max(2_147_483_647), vlan: z.number().int().min(0).max(16_777_215) }).strict())
      .max(8192)
      .optional(),
    lldp: z
      .array(
        z
          .object({
            if_index: z.number().int().min(0).max(2_147_483_647),
            sys_name: z.string().max(120).optional(),
            port_id: z.string().max(80).optional(),
            port_descr: z.string().max(120).optional(),
            chassis_id: z.string().max(80).optional(),
            // lldp (LLDP-MIB), cdp (CISCO-CDP-MIB cdpCacheTable) or mikrotik (MIKROTIK-MIB neighbour table).
            protocol: z.enum(['lldp', 'cdp', 'mikrotik']).optional(),
            address: ipv4.optional(),
            platform: z.string().max(120).optional(),
            version: z.string().max(120).optional(),
          })
          .strict(),
      )
      .max(1536)
      .optional(),
    truncated: z.array(z.enum(['ports', 'fdb'])).max(2).optional(),
  })
  .strict();

const toolResultSchema = z
  .object({
    type: z.literal('tool_result'),
    ts: timestamp,
    run_id: z.uuid(),
    ok: z.boolean(),
    duration_ms: z.number().int().min(0).max(600_000).optional(),
    error: z.string().max(400).optional(),
    output: z.record(z.string().max(60), z.unknown()).optional(),
  })
  .strict();

// Router control (modules/routers). Error kinds mirror the collector's router package.
export const ROUTER_ERROR_KINDS = [
  'bad_credentials', 'locked_out', 'session_expired', 'session_limit', 'unsupported', 'unreachable', 'not_authorized',
  'certificate', 'not_found', 'protocol', 'invalid_argument', 'unknown_vendor', 'rejected', 'no_credentials',
  'not_configured', 'login_suspended', 'internal',
] as const;
const shortText = (n: number) => z.string().max(n);
export const ROUTER_RESULT_ACTIONS = [
  'refresh', 'fetch_certificate', 'block', 'unblock', 'rate_limit', 'clear_rate_limit', 'schedule', 'clear_schedule',
  'rename', 'wifi', 'reserve', 'unreserve', 'add_port_forward', 'remove_port_forward', 'reboot',
] as const;
const port = z.number().int().min(1).max(65535);
// The router's own identifier of a list entry (opaque; only valid until the router's list changes).
const routerEntryId = z.string().min(1).max(40);
/**
 * Router settings as read by the driver (docs/features/router-controls.md). Each part is optional:
 * absent when the router does not offer it or it could not be read. Never a Wi-Fi key, RADIUS
 * secret or password: there is no field for one, and unknown fields are rejected.
 */
export const routerSettingsSchema = z
  .object({
    overview: z
      .object({
        uptime_seconds: z.number().int().min(0).max(1e10).optional(),
        lan_ip: ipv4.optional(),
        wan: z
          .array(
            z
              .object({
                name: z.string().min(1).max(60),
                status: z.enum(['up', 'down', 'connecting', 'unknown']),
                type: shortText(20).optional(),
                ipv4: ipv4.optional(),
                dns: z.array(shortText(45)).max(8).optional(),
                uptime_seconds: z.number().int().min(0).max(1e10).optional(),
              })
              .strict(),
          )
          .max(8)
          .optional(),
      })
      .strict()
      .optional(),
    wifi: z
      .array(
        z
          .object({
            id: routerEntryId,
            band: shortText(20).optional(),
            ssid: shortText(64),
            enabled: z.boolean(),
            main: z.boolean(),
            guest: z.boolean(),
            hidden: z.boolean().optional(),
            security: shortText(60).optional(),
            client_macs: z.array(mac).max(1024).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    reservations: z
      .array(z.object({ id: routerEntryId, mac, ip: ipv4, enabled: z.boolean().optional() }).strict())
      .max(256)
      .optional(),
    port_forwards: z
      .array(
        z
          .object({
            id: routerEntryId,
            enabled: z.boolean(),
            description: shortText(120),
            protocol: z.enum(['tcp', 'udp', 'both']),
            external_start: port,
            external_end: port,
            internal_start: port,
            internal_end: port,
            internal_ip: ipv4,
            owner: z.enum(['lan-detective', 'administrator']),
          })
          .strict(),
      )
      .max(256)
      .optional(),
  })
  .strict();
export type RouterSettings = z.infer<typeof routerSettingsSchema>;
const routerResultSchema = z
  .object({
    type: z.literal('router_result'),
    ts: timestamp,
    router_id: z.uuid(),
    // Present for administrator-requested operations; absent for the collector's scheduled refresh.
    request_id: z.uuid().optional(),
    action: z.enum(ROUTER_RESULT_ACTIONS),
    trigger: z.enum(['scheduled', 'command']),
    ok: z.boolean(),
    duration_ms: z.number().int().min(0).max(3_600_000).optional(),
    mac: mac.optional(),
    error: z
      .object({ kind: z.enum(ROUTER_ERROR_KINDS), message: shortText(400), retry_after_seconds: z.number().int().min(0).max(30 * 86400).optional() })
      .strict()
      .optional(),
    identity: z
      .object({ vendor: shortText(120), model: shortText(120), firmware: shortText(120), extra: z.record(shortText(60), shortText(200)).optional() })
      .strict()
      .optional(),
    capabilities: z
      .array(z.object({ capability: shortText(40), supported: z.boolean(), mechanism: shortText(200).optional(), note: shortText(400).optional() }).strict())
      .max(16)
      .optional(),
    clients: z
      .array(
        z
          .object({
            mac,
            ip: ipv4.optional(),
            hostname: shortText(120).optional(),
            connection: shortText(20),
            interface: shortText(120).optional(),
            signal_dbm: z.number().int().min(-150).max(50).optional(),
            active: z.boolean().optional(),
            blocked: z.boolean().optional(),
            lease_source: shortText(20).optional(),
            lease_remaining_seconds: z.number().int().min(0).max(1e10).optional(),
            raw: z.record(shortText(60), shortText(200)).refine((r) => Object.keys(r).length <= 40, 'too many raw fields').optional(),
          })
          .strict(),
      )
      .max(1024)
      .optional(),
    clients_truncated: z.boolean().optional(),
    blocked: z
      .array(
        z
          .object({
            mac,
            name: shortText(120).optional(),
            mechanism: shortText(120),
            owner: z.enum(['lan-detective', 'administrator', 'unknown']),
            partial: z.boolean().optional(),
            detail: shortText(300).optional(),
            managed: z.boolean(),
          })
          .strict(),
      )
      .max(512)
      .optional(),
    change: z
      .object({
        action: shortText(40),
        // The device's MAC, or "" for a router-wide change (Wi-Fi, port forward, reboot).
        mac: shortText(17),
        mechanism: shortText(200),
        applied: z.boolean(),
        already_in_effect: z.boolean(),
        detail: shortText(400),
        undo: shortText(400),
      })
      .strict()
      .optional(),
    certificate: z
      .object({
        sha256: z.string().regex(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/),
        subject: shortText(300),
        issuer: shortText(300),
        not_before: timestamp,
        not_after: timestamp,
        self_signed: z.boolean(),
        expired: z.boolean(),
        system_trust: z.boolean(),
      })
      .strict()
      .optional(),
    // Refresh, and any control result with ok: true (re-read after the change).
    settings: routerSettingsSchema.optional(),
  })
  .strict();

// What the collector's receive-only MNDP listener heard (MikroTik devices announcing themselves).
const mndpNeighborsSchema = z
  .object({
    type: z.literal('mndp_neighbors'),
    ts: timestamp,
    neighbors: z
      .array(
        z
          .object({
            mac,
            source_ip: ipv4,
            identity: z.string().max(120).optional(),
            platform: z.string().max(120).optional(),
            version: z.string().max(120).optional(),
            board: z.string().max(120).optional(),
            interface_name: z.string().max(120).optional(),
            ipv4: ipv4.optional(),
            ipv6: z.ipv6().optional(),
            uptime_seconds: z.number().int().min(0).max(4_294_967_295).optional(),
            first_seen_at: timestamp,
            last_seen_at: timestamp,
          })
          .strict(),
      )
      .min(1)
      .max(1024),
  })
  .strict();

export const telemetryBatchSchema = z
  .object({
    batch_id: z.uuid(),
    sent_at: timestamp,
    items: z.array(z.discriminatedUnion('type', [discoveryRunSchema, checkResultSchema, dnsStatsSchema, snmpPollSchema, toolResultSchema, routerResultSchema, smartCheckSchema, switchVlansSchema, switchPortResultSchema, configBackupResultSchema, configBackupProbeResultSchema, configRestoreResultSchema, mndpNeighborsSchema])).min(1).max(500),
  })
  .strict();

export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type DiscoveryRunItem = z.infer<typeof discoveryRunSchema>;
export type CheckResultItem = z.infer<typeof checkResultSchema>;
export type SnmpPollItem = z.infer<typeof snmpPollSchema>;
export type DnsStatsItem = z.infer<typeof dnsStatsSchema>;
export type ToolResultItem = z.infer<typeof toolResultSchema>;
export type RouterResultItem = z.infer<typeof routerResultSchema>;
export type MndpNeighborsItem = z.infer<typeof mndpNeighborsSchema>;
export type { ConfigBackupProbeResultItem, ConfigBackupResultItem, ConfigRestoreResultItem } from './config-backup-protocol.ts';
export type { SmartCheckItem } from './smart-check-protocol.ts';
export type { SwitchPortResultItem, SwitchVlansItem } from './switch-port-protocol.ts';
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
