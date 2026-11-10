import { z } from 'zod';
import { isIPv4 } from '../../common/net.ts';

// Universal Endpoint Agent & Mobile/MDM protocol schema — strict validation on every field.

const ipv4 = z.string().max(15).refine(isIPv4, 'must be an IPv4 address');
const mac = z.string().regex(/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/, 'must be a MAC address');
// eslint-disable-next-line no-control-regex
const cleanText = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');

export const platformEnum = z.enum(['windows', 'linux', 'macos', 'android', 'ios']);
export const managementModeEnum = z.enum([
  'agent',
  'android_device_owner',
  'android_work_profile',
  'android_companion',
  'ios_supervised_mdm',
  'ios_byod_mdm',
  'macos_mdm',
]);

export const securityPostureSchema = z
  .object({
    firewall_enabled: z.boolean().optional(),
    antivirus_enabled: z.boolean().optional(),
    disk_encrypted: z.boolean().optional(),
    pending_updates: z.number().int().min(0).max(10_000).optional(),
    last_update_date: z.string().max(40).optional(),
    os_build: z.string().max(60).optional(),
    supervised: z.boolean().optional(),
    device_owner: z.boolean().optional(),
    work_profile: z.boolean().optional(),
    passcode_compliant: z.boolean().optional(),
    rooted_or_jailbroken: z.boolean().optional(),
    screen_recording_granted: z.boolean().optional(),
    accessibility_granted: z.boolean().optional(),
  })
  .strict();

export const endpointPolicySchema = z
  .object({
    allowed_fs_roots: z.array(cleanText(260)).max(20).optional(),
    remote_desktop_consent: z.enum(['unattended', 'prompt']).optional(),
    passcode_required: z.boolean().optional(),
    min_passcode_length: z.number().int().min(4).max(16).optional(),
    camera_disabled: z.boolean().optional(),
    usb_file_transfer_blocked: z.boolean().optional(),
    wifi_ssid: cleanText(64).optional(),
    wifi_security: z.enum(['WPA2', 'WPA3', 'EAP']).optional(),
    vpn_name: cleanText(80).optional(),
    vpn_server: cleanText(160).optional(),
    managed_apps: z.array(cleanText(160)).max(100).optional(),
  })
  .strict();

export const agentEnrollSchema = z
  .object({
    enrollment_token: z.string().min(20).max(200),
    hostname: cleanText(253),
    agent_version: cleanText(40).optional(),
    version: cleanText(40).optional(),
    platform: platformEnum.optional(),
    management_mode: managementModeEnum.optional(),
    os: cleanText(40),
    os_version: cleanText(120).optional(),
    arch: cleanText(40).default('amd64'),
    manufacturer: cleanText(120).optional(),
    model: cleanText(120).optional(),
    serial_number: cleanText(120).optional(),
    security_patch_level: cleanText(40).optional(),
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
    management_mode: managementModeEnum.optional(),
    os: cleanText(40),
    os_version: cleanText(120).optional(),
    arch: cleanText(40).default('amd64'),
    manufacturer: cleanText(120).optional(),
    model: cleanText(120).optional(),
    serial_number: cleanText(120).optional(),
    security_patch_level: cleanText(40).optional(),
    battery_pct: z.number().min(0).max(100).optional(),
    battery_charging: z.boolean().optional(),
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

export interface EndpointContext {
  id: string;
  organizationId: string;
  siteId: string;
  deviceId: string | null;
  name: string;
  platform: z.infer<typeof platformEnum>;
  managementMode: z.infer<typeof managementModeEnum>;
  connectionState: 'never' | 'online' | 'offline';
}
