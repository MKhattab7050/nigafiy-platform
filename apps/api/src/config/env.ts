import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const optionalNonEmpty = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  /** Optional HTTPS listener port when TLS_CERT_FILE and TLS_KEY_FILE are provided. */
  HTTPS_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(65535).optional()),
  /** Interface to listen on; unset = all interfaces. The local launchers set 127.0.0.1. */
  HOST: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  APP_DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes, hex encoded'),
  WEB_ORIGIN: z.string().default('http://localhost:3100'),
  /**
   * Address collectors and endpoint agents should use to reach this server (e.g. https://lan.example.com),
   * returned as `server_url` with enrollment tokens. Unset: the origin each request arrived at is used.
   */
  PUBLIC_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .url({ protocol: /^https?$/ })
      .transform((u) => u.replace(/\/+$/, ''))
      .optional(),
  ),
  TLS_CERT_FILE: optionalNonEmpty,
  TLS_KEY_FILE: optionalNonEmpty,
  TLS_PIN_SHA256: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .trim()
      .regex(/^[0-9A-Fa-f]{2}(:?[0-9A-Fa-f]{2}){31}$/, 'must be a SHA-256 fingerprint (64 hex digits)')
      .transform((s) => s.replaceAll(':', '').toUpperCase().match(/.{2}/g)!.join(':'))
      .optional(),
  ),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(168),
  ALLOW_REGISTRATION: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  TRUST_PROXY: z.string().default('loopback'),
  ALLOW_LOOPBACK_SCOPES: bool,
  ALLOW_PRIVATE_WEBHOOKS: bool,
  /** Allow notification email through a mail relay on a private address. Meant for on-premise installs; keep off when hosting for others. */
  SMTP_ALLOW_PRIVATE_HOSTS: bool,
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    // Never print values: they may be secrets.
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && (env.ALLOW_LOOPBACK_SCOPES || env.ALLOW_PRIVATE_WEBHOOKS)) {
    throw new Error('ALLOW_LOOPBACK_SCOPES / ALLOW_PRIVATE_WEBHOOKS must not be enabled in production');
  }
  return env;
}

export const env: Env = load();

let cachedCertFile: string | undefined;
let cachedCertPin: string | null = null;

/**
 * Leaf certificate SHA-256 fingerprint (colon-separated uppercase hex) for agent TLS pinning when
 * `TLS_PIN_SHA256` or (`TLS_CERT_FILE` + `TLS_KEY_FILE`) are configured.
 */
export function tlsPinSha256(currentEnv: Env = env): string | null {
  if (currentEnv.TLS_PIN_SHA256) {
    return currentEnv.TLS_PIN_SHA256.replaceAll(':', '').toUpperCase().match(/.{2}/g)!.join(':');
  }
  if (currentEnv.TLS_CERT_FILE && currentEnv.TLS_KEY_FILE) {
    if (cachedCertFile === currentEnv.TLS_CERT_FILE && cachedCertPin) return cachedCertPin;
    const cert = new X509Certificate(readFileSync(currentEnv.TLS_CERT_FILE));
    cachedCertFile = currentEnv.TLS_CERT_FILE;
    cachedCertPin = cert.fingerprint256;
    return cachedCertPin;
  }
  return null;
}
