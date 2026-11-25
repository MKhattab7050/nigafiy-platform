import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { withNewNames } from './env-compat.ts';

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
   * Fleet live sessions with several API instances: the address other instances use to reach THIS
   * instance for the remote-desktop frame relay (e.g. http://10.0.0.5:4100). Unset:
   * http://127.0.0.1:<PORT> (instances on one host). See docs/features/fleet-pro.md.
   */
  RD_PEER_URL: optionalNonEmpty,
  /**
   * Fleet live sessions: WebRTC video (H.264, a direct browser ↔ agent peer connection on the LAN).
   * "off" keeps every session on the WebSocket + JPEG stream. See docs/features/fleet-pro.md
   * "WebRTC video".
   */
  RD_WEBRTC: z.enum(['on', 'off']).default('on'),
  /**
   * Optional STUN servers for WebRTC video, comma separated (stun: or stuns: only; empty by
   * default: host candidates on the LAN). TURN is not offered: the product is LAN first and a relay
   * would carry the picture through a third machine.
   */
  RD_WEBRTC_STUN_URLS: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []),
    z.array(z.string().max(200).regex(/^stuns?:[A-Za-z0-9.\-[\]:]+$/, 'must be a stun: or stuns: URL')).max(4),
  ),
  /**
   * Fleet Quick Support: path of the built nigafiy-support.exe that Fleet hands out (with the signed
   * server binding appended). Unset: agents/endpoint-agent/bin/nigafiy-support.exe in this checkout.
   */
  QUICK_SUPPORT_EXE: optionalNonEmpty,
  /**
   * Fleet Android: path of the signed Nigafiy agent APK that Device Owner QR provisioning downloads
   * (GET /api/v1/agent/android/agent.apk). Unset: the release build in this checkout
   * (agents/android-agent/app/build/outputs/apk/release/app-release.apk, pnpm build:android).
   */
  NIGAFIY_ANDROID_APK: optionalNonEmpty,
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
  /** Interface for the HTTPS listener (e.g. 0.0.0.0 to serve collectors on the LAN). Unset: HOST. */
  HTTPS_HOST: optionalNonEmpty,
  /**
   * Built-in LAN TLS (infrastructure/lan-tls.ts): with HTTPS_PORT set and no TLS_CERT_FILE /
   * TLS_KEY_FILE, "auto" (default) creates a local CA and server certificate under TLS_AUTO_DIR and
   * renews them; "off" starts no HTTPS listener without certificate files.
   */
  LAN_TLS: z.enum(['auto', 'off']).default('auto'),
  /** Where the built-in LAN TLS files live. Unset: <working directory>/.data/tls. scripts/local.mjs sets <data dir>/tls. */
  TLS_AUTO_DIR: optionalNonEmpty,
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
  /**
   * Optional shared store for rate-limit counters (redis:// or rediss://), so limits hold across API
   * instances. Unset: per-instance memory, as before (infrastructure/rate-limit-store.ts).
   */
  REDIS_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^rediss?$/ }).optional()),
  ALLOW_LOOPBACK_SCOPES: bool,
  ALLOW_PRIVATE_WEBHOOKS: bool,
  /** Allow notification email through a mail relay on a private address. Meant for on-premise installs; keep off when hosting for others. */
  SMTP_ALLOW_PRIVATE_HOSTS: bool,
  /**
   * The local engine's control address (nigafiy-engine, docs/desktop/engine.md). Read-only status
   * is shown on the Hub home. Must be a loopback http URL; "off" disables the lookup.
   */
  ENGINE_CONTROL_URL: z
    .string()
    .default('http://127.0.0.1:47140')
    .refine((v) => v === 'off' || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(v), 'must be http://127.0.0.1:<port> or "off"'),
  /** Signed release manifest for update checks. Unset: update checks are off (and the Hub says so). */
  NIGAFIY_UPDATE_MANIFEST_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url({ protocol: /^https?$/ }).optional()),
  /** Ed25519 public key (base64 of the 32 raw bytes) that release manifests must be signed with. */
  NIGAFIY_UPDATE_PUBLIC_KEY: optionalNonEmpty,
  /** The manifest component this install updates itself from (the desktop app's NSIS installer). */
  NIGAFIY_UPDATE_COMPONENT: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).default('desktop-windows-x64'),
  /**
   * SHA-1 thumbprint of the certificate update installers must be Authenticode-signed with
   * (docs/operations/updates.md). Unset: only the SHA-256 from the signed manifest is checked.
   */
  NIGAFIY_UPDATE_PUBLISHER_THUMBPRINT: z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/[\s:]/g, '').toUpperCase() || undefined : v),
    z.string().regex(/^[0-9A-F]{40}$/, 'must be a 40-character SHA-1 thumbprint').optional(),
  ),
  /** Largest update download accepted, in bytes (default 1.5 GiB). */
  NIGAFIY_UPDATE_MAX_BYTES: z.coerce.number().int().min(1024).max(8 * 1024 ** 3).default(1.5 * 1024 ** 3),
  /** The data folder shared with the engine (set by the engine and the desktop app). Updates are staged in <NIGAFIY_DATA_DIR>/updates. The legacy LD_DATA_DIR is still read (env-compat.ts). */
  NIGAFIY_DATA_DIR: optionalNonEmpty,
  /**
   * Which Nigafiy programs this install offers (GET /platform/programs): "all" (default: one desktop
   * install carries every program until Milestone 5 ships one installer per program) or a comma list
   * such as "hub,radar,watch". Hub is always installed. Only decides which UI is offered, never which
   * data is collected (spec §6.1).
   */
  NIGAFIY_PROGRAMS: z
    .string()
    .default('all')
    .transform((v) => v.trim().toLowerCase())
    .refine((v) => v === 'all' || v.split(',').every((id) => ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'].includes(id.trim())), 'must be "all" or a comma list of hub, radar, watch, guard, fleet, mind, toolbox'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  // Legacy LD_* names fill their NIGAFIY_* twins (the new name wins).
  const parsed = schema.safeParse(withNewNames(process.env));
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
