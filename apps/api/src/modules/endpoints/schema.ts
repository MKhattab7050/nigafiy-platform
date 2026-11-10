import { z } from 'zod';
import { isIPv4 } from '../../common/net.ts';

// Endpoint Agent protocol v1 — strict validation on every field an agent sends.

const ipv4 = z.string().max(15).refine(isIPv4, 'must be an IPv4 address');
const mac = z.string().regex(/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/, 'must be a MAC address');
// eslint-disable-next-line no-control-regex
const cleanText = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');

export const agentEnrollSchema = z
  .object({
    enrollment_token: z.string().min(20).max(200),
    hostname: cleanText(253),
    agent_version: cleanText(40),
    os: cleanText(40),
    os_version: cleanText(120).optional(),
    arch: cleanText(40),
    cpu_model: cleanText(160).optional(),
    cpu_cores: z.number().int().min(1).max(1024).optional(),
    ram_total_mb: z.number().int().min(1).max(16_777_216).optional(),
    primary_ip: ipv4.optional(),
    primary_mac: mac.optional(),
  })
  .strict();

export const diskSchema = z
  .object({
    mount: cleanText(120),
    filesystem: cleanText(60).optional(),
    total_gb: z.number().min(0).max(1_000_000),
    used_gb: z.number().min(0).max(1_000_000),
    free_gb: z.number().min(0).max(1_000_000),
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
    output: z.string().max(4000).optional(),
    error: z.string().max(1000).optional(),
  })
  .strict();

export const agentHeartbeatSchema = z
  .object({
    agent_version: cleanText(40),
    hostname: cleanText(253),
    os: cleanText(40),
    os_version: cleanText(120).optional(),
    arch: cleanText(40),
    cpu_model: cleanText(160).optional(),
    cpu_cores: z.number().int().min(1).max(1024).optional(),
    ram_total_mb: z.number().int().min(1).max(16_777_216).optional(),
    uptime_seconds: z.number().int().min(0),
    logged_in_users: z.array(cleanText(120)).max(32).default([]),
    primary_ip: ipv4.optional(),
    primary_mac: mac.optional(),
    cpu_pct: z.number().min(0).max(100),
    ram_used_mb: z.number().int().min(0).max(16_777_216),
    ram_pct: z.number().min(0).max(100),
    disk_used_pct: z.number().min(0).max(100).optional(),
    disks: z.array(diskSchema).max(32).optional(),
    interfaces: z.array(interfaceSchema).max(32).optional(),
    command_results: z.array(commandResultSchema).max(50).default([]),
  })
  .strict();

export const processSchema = z
  .object({
    pid: z.number().int().min(0).max(2_147_483_647),
    name: cleanText(160),
    cpu_pct: z.number().min(0).max(10_000).optional(),
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
    start_mode: z.enum(['auto', 'manual', 'disabled', 'other']).optional(),
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
    proto: z.enum(['tcp', 'udp']),
    local_address: cleanText(64),
    local_port: z.number().int().min(0).max(65535),
    remote_address: cleanText(64).optional(),
    remote_port: z.number().int().min(0).max(65535).optional(),
    state: cleanText(40),
    pid: z.number().int().min(0).max(2_147_483_647).optional(),
    process_name: cleanText(160).optional(),
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
  connectionState: 'never' | 'online' | 'offline';
}

