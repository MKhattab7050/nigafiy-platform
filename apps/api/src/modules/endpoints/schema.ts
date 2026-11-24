import { z } from 'zod';
import { isIPv4 } from '../../common/net.ts';

// Endpoint agent protocol schema (Windows, Linux, macOS) — strict validation on every field.

const ipv4 = z.string().max(15).refine(isIPv4, 'must be an IPv4 address');
const mac = z.string().regex(/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/, 'must be a MAC address');
// eslint-disable-next-line no-control-regex
const cleanText = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');

export const platformEnum = z.enum(['windows', 'linux', 'macos']);

// eslint-disable-next-line no-control-regex
const evidenceText = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');

/** One measured compliance fact from the agent: the command, what it printed (summarised) and when. */
export const securityEvidenceSchema = z
  .object({
    check: z.enum(['firewall', 'antivirus', 'disk_encryption', 'os_updates', 'sip', 'gatekeeper', 'local_admins']),
    subject: cleanText(120),
    state: z.enum(['pass', 'fail', 'warn', 'unknown', 'info']),
    value: evidenceText(300),
    source: cleanText(200),
    measured_at: z.iso.datetime({ offset: true }),
    reason: evidenceText(300).optional(),
    count: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export const securityPostureSchema = z
  .object({
    firewall_enabled: z.boolean().optional(),
    antivirus_enabled: z.boolean().optional(),
    disk_encrypted: z.boolean().optional(),
    pending_updates: z.number().int().min(0).max(100_000).optional(),
    last_update_date: z.string().max(40).optional(),
    os_build: z.string().max(60).optional(),
    checks: z.array(securityEvidenceSchema).max(64).optional(),
    measured_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const endpointPolicySchema = z
  .object({
    allowed_fs_roots: z.array(cleanText(260)).max(20).optional(),
    remote_desktop_consent: z.enum(['unattended', 'prompt']).optional(),
    allowed_local_admins: z.array(cleanText(256)).max(50).optional(),
  })
  .strict();

export const agentEnrollSchema = z
  .object({
    enrollment_token: z.string().min(20).max(200),
    hostname: cleanText(253),
    agent_version: cleanText(40).optional(),
    version: cleanText(40).optional(),
    platform: platformEnum.optional(),
    os: cleanText(40),
    os_version: cleanText(120).optional(),
    arch: cleanText(40).default('amd64'),
    manufacturer: cleanText(120).optional(),
    model: cleanText(120).optional(),
    serial_number: cleanText(120).optional(),
    cpu_model: cleanText(160).optional(),
    cpu_cores: z.number().int().min(1).max(1024).optional(),
    ram_total_mb: z.number().int().min(1).max(16_777_216).optional(),
    primary_ip: ipv4.optional(),
    primary_mac: mac.optional(),
    security: securityPostureSchema.optional(),
  })
  .strict();

export const diskSchema = z
  .object({
    mount: cleanText(120),
    filesystem: cleanText(60).optional(),
    total_gb: z.number().min(0).max(1_000_000),
    used_gb: z.number().min(0).max(1_000_000),
    free_gb: z.number().min(0).max(1_000_000).optional(),
    used_pct: z.number().min(0).max(100),
  })
  .strict();

export const interfaceSchema = z
  .object({
    name: cleanText(120),
    mac: mac.optional(),
    addresses: z.array(cleanText(64)).max(16),
  })
  .strict();

export const commandResultSchema = z
  .object({
    id: z.uuid(),
    ok: z.boolean(),
    output: z.string().max(32_000).optional(),
    error: z.string().max(2000).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const processSchema = z
  .object({
    pid: z.number().int().min(0).max(2_147_483_647),
    name: cleanText(160),
    cpu_pct: z.number().min(0).max(10_000).optional(),
    cpu_s: z.number().min(0).max(100_000_000).optional(),
    mem_mb: z.number().min(0).max(16_777_216),
    user: cleanText(120).optional(),
    command: cleanText(300).optional(),
  })
  .strict();

export const serviceSchema = z
  .object({
    name: cleanText(160),
    display_name: cleanText(240),
    state: z.enum(['running', 'stopped', 'other']),
    start_mode: z.string().max(40).optional(),
  })
  .strict();

export const softwareSchema = z
  .object({
    name: cleanText(240),
    version: cleanText(120).optional(),
    publisher: cleanText(160).optional(),
    install_date: cleanText(40).optional(),
  })
  .strict();

export const connectionSchema = z
  .object({
    proto: z.string().max(16),
    local_address: cleanText(64).optional(),
    local_addr: cleanText(80).optional(),
    local_port: z.number().int().min(0).max(65535).optional(),
    remote_address: cleanText(64).optional(),
    remote_addr: cleanText(80).optional(),
    remote_port: z.number().int().min(0).max(65535).optional(),
    state: cleanText(40),
    pid: z.number().int().min(0).max(2_147_483_647).optional(),
    process_name: cleanText(160).optional(),
  })
  .strict();

export const agentHeartbeatSchema = z
  .object({
    agent_version: cleanText(40).optional(),
    version: cleanText(40).optional(),
    hostname: cleanText(253),
    platform: platformEnum.optional(),
    os: cleanText(40),
    os_version: cleanText(120).optional(),
    arch: cleanText(40).default('amd64'),
    manufacturer: cleanText(120).optional(),
    model: cleanText(120).optional(),
    serial_number: cleanText(120).optional(),
    cpu_model: cleanText(160).optional(),
    cpu_cores: z.number().int().min(1).max(1024).optional(),
    ram_total_mb: z.number().int().min(1).max(16_777_216).optional(),
    uptime_seconds: z.number().int().min(0).default(0),
    logged_in_users: z.array(cleanText(120)).max(32).default([]),
    primary_ip: ipv4.optional(),
    primary_mac: mac.optional(),
    cpu_pct: z.number().min(0).max(100).default(0),
    ram_used_mb: z.number().int().min(0).max(16_777_216).default(0),
    ram_pct: z.number().min(0).max(100).default(0),
    disk_used_pct: z.number().min(0).max(100).optional(),
    disks: z.array(diskSchema).max(32).optional(),
    interfaces: z.array(interfaceSchema).max(32).optional(),
    processes: z.array(processSchema).max(300).optional(),
    services: z.array(serviceSchema).max(500).optional(),
    software: z.array(softwareSchema).max(1000).optional(),
    connections: z.array(connectionSchema).max(500).optional(),
    security: securityPostureSchema.optional(),
    command_results: z.array(commandResultSchema).max(50).optional(),
    completed_commands: z.array(commandResultSchema).max(50).optional(),
    // Fleet Pro (migration 037): Windows user sessions (WTSEnumerateSessions) and the boot state
    // (safe mode, safe-boot flag, running as the service).
    user_sessions: z
      .array(
        z
          .object({
            id: z.number().int().min(0).max(65_535),
            user: cleanText(120).nullable(),
            domain: cleanText(120).nullable(),
            state: z.enum(['active', 'connected', 'disconnected', 'idle', 'listen', 'other']),
            station: cleanText(64).nullable(),
            console: z.boolean(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    boot_state: z.object({ safe_mode: z.boolean().optional(), safe_boot_flag: z.boolean().optional(), service: z.boolean().optional() }).strict().optional(),
  })
  .strict();

export const agentInventorySchema = z
  .object({
    disks: z.array(diskSchema).max(32).default([]),
    interfaces: z.array(interfaceSchema).max(32).default([]),
    processes: z.array(processSchema).max(300).default([]),
    services: z.array(serviceSchema).max(500).default([]),
    software: z.array(softwareSchema).max(1000).default([]),
    connections: z.array(connectionSchema).max(500).default([]),
  })
  .strict();

/** POST /api/v1/agent/command-result: results delivered as soon as a command finishes. */
export const agentCommandResultsSchema = z
  .object({
    command_results: z.array(commandResultSchema).min(1).max(50),
  })
  .strict();

export type AgentEnroll = z.infer<typeof agentEnrollSchema>;
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;
export type AgentInventory = z.infer<typeof agentInventorySchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;

export interface EndpointContext {
  id: string;
  organizationId: string;
  siteId: string;
  deviceId: string | null;
  name: string;
  platform: z.infer<typeof platformEnum>;
  connectionState: 'never' | 'online' | 'offline';
}

// ── User-facing API (/api/v1/endpoints/*) ───────────────────────────────────

export const endpointListQuery = z.object({
  site_id: z.uuid().optional(),
  device_id: z.uuid().optional(),
  platform: platformEnum.optional(),
  compliance_status: z.enum(['compliant', 'non_compliant', 'attention', 'unknown']).optional(),
  // A fleet group id, or "none" for endpoints in no group.
  fleet_group: z.union([z.uuid(), z.literal('none')]).optional(),
  // Address book (migration 037): free text (name, host name, Nigafiy ID, IP, signed-in user), a tag,
  // the operator's favourites only, a signed-in user name.
  q: z.string().trim().min(1).max(120).optional(),
  tag: z.string().trim().toLowerCase().min(1).max(32).optional(),
  favourites: z.enum(['1', 'true']).optional(),
  user: z.string().trim().min(1).max(120).optional(),
});

export const endpointCreateSchema = z
  .object({
    site_id: z.uuid(),
    name: z.string().trim().min(1).max(80),
    platform: platformEnum.default('windows'),
    device_id: z.uuid().nullable().optional(),
  })
  .strict();
export type EndpointCreate = z.infer<typeof endpointCreateSchema>;

export const seriesQuery = z.object({ range: z.enum(['15m', '1h', '24h', '7d', '30d']).default('1h') });
export type SeriesRange = z.infer<typeof seriesQuery>['range'];
