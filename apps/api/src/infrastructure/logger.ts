import { pino } from 'pino';
import { env } from '../config/env.ts';

/**
 * Field names whose values are secrets. Each is redacted at the top level of a log object and one
 * or two levels down (`{ router: { password } }`, `{ body: { snmp: { community } } }`). Covers the
 * credentials Nigafiy handles: account and router passwords, SNMP v1/v2c communities and v3 keys,
 * SMTP passwords, OIDC client secrets, webhook URLs that carry their own secret (Slack, Discord),
 * collector/agent tokens and credentials, MFA and step-up tokens and recovery codes. EXT-9 in
 * docs/security/review-2026-11.md.
 */
export const REDACTED_FIELDS = [
  'password',
  'current_password',
  'new_password',
  'router_password',
  'smtp_password',
  'secret',
  'client_secret',
  'oidc_client_secret',
  'webhook_secret',
  'webhook_url',
  'bot_token',
  'community',
  'snmp_community',
  'auth_password',
  'priv_password',
  'auth_key',
  'priv_key',
  'private_key',
  'api_key',
  'token',
  'mfa_token',
  'step_up_token',
  'enrollment_token',
  'credential',
  'recovery_codes',
  'authorization',
  'cookie',
] as const;

const paths = REDACTED_FIELDS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

// Structured JSON logs. Anything that could carry a credential is redacted at the logger level,
// so a careless `logger.info({ req })` cannot leak it.
export const loggerOptions = {
  redact: {
    paths: [...paths, 'headers.authorization', 'headers.cookie', 'req.headers.authorization', 'req.headers.cookie'],
    censor: '[redacted]',
  },
  base: { service: 'nigafiy-api' },
};

export const logger = pino({
  level: env.NODE_ENV === 'test' && !process.env.TEST_LOGS ? 'silent' : env.LOG_LEVEL,
  ...loggerOptions,
});
