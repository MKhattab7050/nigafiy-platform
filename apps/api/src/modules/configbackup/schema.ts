import { z } from 'zod';
import { CONFIG_BACKUP_DRIVER_IDS, HOST_KEY_FINGERPRINT } from '../../common/config-backup-protocol.ts';

/** Devices one site can back up. */
export const MAX_TARGETS_PER_SITE = 500;
/** Targets added in one request (e.g. "add all suggested switches"). */
export const MAX_BULK_TARGETS = 50;
/** A backup the collector did not report within this time expires (it may also wait behind others). */
export const RUN_TTL_MINUTES = 20;
/** An SSH reachability check not reported within this time expires. */
export const PROBE_TTL_MINUTES = 10;
/** Addresses checked in one SSH reachability run. */
export const MAX_PROBE_ADDRESSES = 1024;
/** The automatic SSH reachability check runs at most this often per site. */
export const PROBE_EVERY_HOURS = 24;
/** Normalized configurations larger than this are refused (the collector caps output at 1 MiB per command). */
export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

const secret = (max: number) => z.string().min(1).max(max);

export const credentialsSchema = z
  .object({
    username: z.string().trim().min(1).max(64),
    password: secret(256).optional(),
    // OpenSSH, PKCS#1 or PKCS#8 PEM.
    private_key: z
      .string()
      .max(16_384)
      .refine((k) => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(k), 'must be a PEM private key (-----BEGIN … PRIVATE KEY-----)')
      .optional(),
    passphrase: secret(256).optional(),
    // Cisco IOS / ASA "enable" secret, needed when the account logs in unprivileged (prompt ends with '>').
    enable_secret: secret(256).optional(),
  })
  .strict()
  .refine((c) => !!c.password || !!c.private_key, { message: 'give a password or a private key', path: ['password'] });
export type Credentials = z.infer<typeof credentialsSchema>;

const driver = z.enum(CONFIG_BACKUP_DRIVER_IDS).nullable();

export const listQuery = z.object({ site_id: z.uuid().optional() });

export const targetsCreateSchema = z
  .object({
    site_id: z.uuid(),
    targets: z
      .array(
        z
          .object({
            address: z.ipv4(),
            port: z.number().int().min(1).max(65535).default(22),
            name: z.string().trim().min(1).max(80).optional(),
            // null / absent: auto-detect on every backup.
            driver: driver.default(null),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BULK_TARGETS),
    // One set of credentials for every device in the request (network gear usually shares one account).
    credentials: credentialsSchema.optional(),
    schedule: z.enum(['daily', 'off']).default('daily'),
    schedule_hour: z.number().int().min(0).max(23).default(2),
    // Queue a first backup right away when the credentials are given and a collector is online.
    run_now: z.boolean().default(true),
  })
  .strict();
export type TargetsCreate = z.infer<typeof targetsCreateSchema>;

export const targetPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    port: z.number().int().min(1).max(65535),
    driver,
    enabled: z.boolean(),
    schedule: z.enum(['daily', 'off']),
    schedule_hour: z.number().int().min(0).max(23),
  })
  .partial()
  .strict();
export type TargetPatch = z.infer<typeof targetPatchSchema>;

/** Either new credentials, or "use the same credentials as that other device". */
export const credentialsUpdateSchema = z.union([
  z.object({ credentials: credentialsSchema }).strict(),
  z.object({ copy_from_target_id: z.uuid() }).strict(),
]);

export const hostKeyAcceptSchema = z.object({ sha256: z.string().trim().regex(HOST_KEY_FINGERPRINT, 'an SSH fingerprint (SHA256:…)') }).strict();

export const diffQuery = z.object({ from: z.uuid(), to: z.uuid(), context: z.coerce.number().int().min(0).max(20).default(3) });

export const versionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export const probeSchema = z.object({ site_id: z.uuid() }).strict();

/** A restore: the backup before it plus the restore itself must finish within this time. */
export const RESTORE_TTL_MINUTES = 30;
/** The `config_restore` command must start within this time after the backup before it. */
export const RESTORE_COMMAND_TTL_MINUTES = 15;

export const restorePreviewQuery = z.object({ version_id: z.uuid() });

export const restoreRequestSchema = z
  .object({
    version_id: z.uuid(),
    /** The device name, typed by the administrator. */
    confirm: z.string().max(200),
    reason: z.string().trim().min(10).max(500),
    /** Minutes the device waits for the confirmation before it rolls back by itself (Junos `commit confirmed`). */
    confirm_minutes: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;
