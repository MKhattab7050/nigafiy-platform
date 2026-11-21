import { z } from 'zod';
import { isIPv4 } from './net.ts';

// Collector protocol v1 — configuration backup items (modules/configbackup). Kept in its own file so
// the shared collector-protocol.ts only gains union members. `.strict()` everywhere.
//
//  config_backup_result        the outcome of one `config_backup` command: the SSH host key the
//                              device presented, vendor detection with its evidence, and — on
//                              success — the running configuration, gzip-compressed and base64-encoded
//                              (a 1 MiB configuration stays far below the gateway's body limit)
//  config_backup_probe_result  the outcome of one `config_backup_probe` command: for each address,
//                              whether TCP port 22 (or the given port) answered with an SSH
//                              identification line. No login is attempted.

const timestamp = z.iso.datetime({ offset: true });
// eslint-disable-next-line no-control-regex
const clean = (max: number) => z.string().max(max).regex(/^[^\u0000-\u0008\u000b-\u001f\u007f]*$/, 'control characters are not allowed');
const ipv4 = z.string().max(15).refine(isIPv4, 'must be an IPv4 address');

/** Error kinds of the collector's configbackup package (internal/configbackup/configbackup.go). */
export const CONFIG_BACKUP_ERROR_KINDS = [
  'out_of_scope', 'unreachable', 'timeout', 'auth_failed', 'host_key_changed', 'privilege', 'unsupported_vendor', 'command_failed',
  'output_too_large', 'protocol', 'invalid_argument', 'empty_config', 'expired', 'internal',
] as const;
export type ConfigBackupErrorKind = (typeof CONFIG_BACKUP_ERROR_KINDS)[number];

/** Drivers shipped in the collector (internal/configbackup/drivers.go), in the collector's order. */
export const CONFIG_BACKUP_DRIVERS = [
  { id: 'cisco_ios', name: 'Cisco IOS / IOS-XE' },
  { id: 'cisco_nxos', name: 'Cisco NX-OS' },
  { id: 'cisco_asa', name: 'Cisco ASA' },
  { id: 'aruba_procurve', name: 'Aruba / HPE ProCurve (ArubaOS-Switch)' },
  { id: 'aruba_aoscx', name: 'Aruba AOS-CX' },
  { id: 'juniper_junos', name: 'Juniper Junos' },
  { id: 'mikrotik_routeros', name: 'MikroTik RouterOS' },
  { id: 'fortinet_fortios', name: 'Fortinet FortiOS' },
  { id: 'vyos_edgeos', name: 'Ubiquiti EdgeOS / VyOS' },
  { id: 'huawei_vrp', name: 'Huawei VRP' },
  { id: 'dell_os10', name: 'Dell OS10' },
  { id: 'dell_os6', name: 'Dell OS6 (N-Series)' },
  { id: 'openwrt', name: 'OpenWrt / Linux (UCI)' },
  { id: 'paloalto_panos', name: 'Palo Alto PAN-OS' },
] as const;
export const CONFIG_BACKUP_DRIVER_IDS = CONFIG_BACKUP_DRIVERS.map((d) => d.id) as unknown as readonly [string, ...string[]];

/** OpenSSH-style SHA-256 fingerprint, as golang.org/x/crypto/ssh.FingerprintSHA256 prints it. */
export const HOST_KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** Base64 of the gzip stream. ~1.4 MB of base64 ≈ 1 MB compressed — far more than any real configuration. */
export const MAX_CONFIG_GZIP_B64 = 1_400_000;

export const configBackupResultSchema = z
  .object({
    type: z.literal('config_backup_result'),
    ts: timestamp,
    run_id: z.uuid(),
    target_id: z.uuid(),
    ok: z.boolean(),
    duration_ms: z.number().int().min(0).max(3_600_000).optional(),
    host_key: z.object({ sha256: z.string().regex(HOST_KEY_FINGERPRINT), type: clean(60) }).strict().optional(),
    host_key_status: z.enum(['first_use', 'matched', 'changed']).optional(),
    server_version: clean(200).optional(),
    detection: z
      .object({
        driver: z.string().max(40),
        confidence: z.enum(['high', 'medium', 'low', 'manual', '']),
        evidence: z
          .array(
            z
              .object({
                source: z.enum(['server_version', 'banner', 'prompt', 'probe', 'oui_vendor', 'sys_descr', 'previous', 'override']),
                driver: z.string().max(40).optional(),
                detail: clean(300),
                weight: z.number().int().min(0).max(1000),
              })
              .strict(),
          )
          .max(64)
          .nullable()
          .optional(),
        prompt: clean(200).optional(),
        prompt_family: clean(40).optional(),
      })
      .strict()
      .optional(),
    commands: z.array(clean(120)).max(16).optional(),
    config_gzip_b64: z.string().max(MAX_CONFIG_GZIP_B64).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be base64').optional(),
    error: z.object({ kind: z.enum(CONFIG_BACKUP_ERROR_KINDS), message: clean(500) }).strict().optional(),
  })
  .strict();

export const configBackupProbeResultSchema = z
  .object({
    type: z.literal('config_backup_probe_result'),
    ts: timestamp,
    run_id: z.uuid(),
    results: z
      .array(
        z
          .object({
            address: ipv4,
            port: z.number().int().min(1).max(65535),
            open: z.boolean(),
            server_version: clean(200).optional(),
            error: clean(200).optional(),
          })
          .strict(),
      )
      .max(1024),
  })
  .strict();

export type ConfigBackupResultItem = z.infer<typeof configBackupResultSchema>;
export type ConfigBackupProbeResultItem = z.infer<typeof configBackupProbeResultSchema>;
