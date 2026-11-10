import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  /** Interface to listen on; unset = all interfaces. The local launchers set 127.0.0.1. */
  HOST: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  APP_DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes, hex encoded'),
  WEB_ORIGIN: z.string().default('http://localhost:3100'),
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
