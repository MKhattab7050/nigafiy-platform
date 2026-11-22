import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { AppError } from '../../common/http.ts';
import { isIPv4 } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';

/**
 * The application-level watch checks (http / https / tls_expiry / snmp_oid): their settings, how
 * they are validated, and how a measured value is classified against thresholds.
 *
 * The collector executes them (collectors/lan-collector/internal/watch) and re-applies the target
 * rule on every resolved address; the API applies it before a check is stored. See
 * docs/features/watch-checks.md.
 */

export const CHECK_KINDS = ['icmp', 'tcp', 'dns', 'http', 'https', 'tls_expiry', 'snmp_oid'] as const;
export type Kind = (typeof CHECK_KINDS)[number];
export const WATCH_KINDS: readonly Kind[] = ['http', 'https', 'tls_expiry', 'snmp_oid'];

/** Bytes of the response body the collector reads for a body assertion; the rest is never read. */
export const MAX_BODY_BYTES = 256 * 1024;

const sha256 = z
  .string()
  .trim()
  .transform((s) => s.replaceAll(':', '').toLowerCase())
  .pipe(z.string().regex(/^[0-9a-f]{64}$/, 'A SHA-256 fingerprint is 64 hexadecimal digits (colons allowed)'));

// Lookaround and back-references are not available in the collector's regular expression engine
// (Go RE2, linear time, so a pattern can never hang the collector). Refused here so the error is immediate.
const UNSUPPORTED_REGEX = /\(\?<?[=!]|\\[1-9]|\\k</;
const bodyMatch = z
  .object({
    mode: z.enum(['substring', 'regex']),
    pattern: z.string().min(1).max(200),
    /** true: the check fails when the pattern IS found (e.g. "Maintenance mode"). */
    negate: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode !== 'regex') return;
    if (UNSUPPORTED_REGEX.test(v.pattern)) {
      ctx.addIssue({ code: 'custom', message: 'Lookaround and back-references are not supported in body patterns', path: ['pattern'] });
      return;
    }
    try {
      new RegExp(v.pattern);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'The body pattern is not a valid regular expression', path: ['pattern'] });
    }
  });

const PATH = /^\/[\x21-\x7e]*$/; // printable ASCII, no spaces or control characters

export const httpConfig = z
  .object({
    path: z.string().max(2000).regex(PATH, 'The path must start with "/" and contain no spaces').default('/'),
    method: z.enum(['GET', 'HEAD']).default('GET'),
    expect_status: z
      .object({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) })
      .strict()
      .refine((s) => s.min <= s.max, 'The expected status range is reversed')
      .default({ min: 200, max: 299 }),
    body_match: bodyMatch.nullable().default(null),
    follow_redirects: z.boolean().default(true),
    max_redirects: z.number().int().min(0).max(10).default(5),
    /** https only. On by default; turning it off is recorded in the audit log. */
    tls_verify: z.boolean().default(true),
    /** https only: the SHA-256 of the server's leaf certificate (DER) that must be presented. */
    pin_sha256: sha256.nullable().default(null),
    /** Explicit opt-in to reach a public internet host (like webhook / e-mail destinations). */
    allow_public: z.boolean().default(false),
  })
  .strict()
  .refine((c) => !(c.method === 'HEAD' && c.body_match), { message: 'A HEAD request has no body to match', path: ['body_match'] });
export type HttpConfig = z.infer<typeof httpConfig>;

const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export const tlsConfig = z
  .object({
    /** Server name sent in the TLS handshake; defaults to the target when it is a name. */
    sni: z.string().trim().max(253).regex(HOSTNAME, 'SNI must be a host name').nullable().default(null),
    warn_days: z.number().min(1).max(365).default(30),
    critical_days: z.number().min(0).max(365).default(7),
    allow_public: z.boolean().default(false),
  })
  .strict()
  .refine((c) => c.critical_days < c.warn_days, { message: 'The critical threshold must be fewer days than the warning threshold', path: ['critical_days'] });
export type TlsConfig = z.infer<typeof tlsConfig>;

const OID = z
  .string()
  .trim()
  .max(128)
  .regex(/^\.?1(\.(0|[1-9]\d{0,9}))+$/, 'An OID is numeric, e.g. 1.3.6.1.2.1.2.2.1.8.3')
  .transform((s) => (s.startsWith('.') ? s : `.${s}`));

export const SNMP_PRESETS = ['cpu', 'memory', 'temperature', 'link_status', 'custom'] as const;
export const COMPARISONS = ['gt', 'lt', 'eq', 'ne'] as const;
export type Comparison = (typeof COMPARISONS)[number];

export const snmpConfig = z
  .object({
    preset: z.enum(SNMP_PRESETS).default('custom'),
    oid: OID,
    /** When set, the value is 100 × oid / ratio_oid (e.g. used / size of a storage entry = % used). */
    ratio_oid: OID.nullable().default(null),
    /** Multiplier applied to the raw value (e.g. 0.1 for a sensor reported in tenths of a degree). */
    scale: z.number().positive().max(1_000_000).default(1),
    comparison: z.enum(COMPARISONS),
    warn: z.number().min(-1e12).max(1e12).nullable().default(null),
    critical: z.number().min(-1e12).max(1e12).nullable().default(null),
    unit: z.string().trim().max(16).default(''),
  })
  .strict()
  .refine((c) => c.warn !== null || c.critical !== null, { message: 'Set a warning or a critical threshold (or both)', path: ['critical'] })
  .refine((c) => c.warn === null || c.critical === null || (c.comparison === 'gt' ? c.critical >= c.warn : c.comparison === 'lt' ? c.critical <= c.warn : true), {
    message: 'The critical threshold must be at least as severe as the warning threshold',
    path: ['critical'],
  });
export type SnmpConfig = z.infer<typeof snmpConfig>;

export function configSchemaFor(kind: Kind): z.ZodType | null {
  if (kind === 'http' || kind === 'https') return httpConfig;
  if (kind === 'tls_expiry') return tlsConfig;
  if (kind === 'snmp_oid') return snmpConfig;
  return null;
}

/** Validates (and fills defaults of) a check's config for its kind. Basic kinds take no config. */
export function parseConfig(kind: Kind, raw: unknown): Record<string, unknown> {
  const schema = configSchemaFor(kind);
  if (!schema) {
    if (raw !== undefined && raw !== null && !(typeof raw === 'object' && Object.keys(raw as object).length === 0)) {
      throw new AppError(400, 'invalid_config', `A ${kind} check takes no settings`);
    }
    return {};
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new AppError(400, 'invalid_config', `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`);
  }
  const config = parsed.data as Record<string, unknown>;
  if (kind === 'http') {
    // Plain HTTP has no certificate: these settings would silently do nothing.
    if (config.pin_sha256) throw new AppError(400, 'invalid_config', 'A certificate pin needs an https check');
    delete config.tls_verify;
    delete config.pin_sha256;
  }
  return config;
}

/**
 * The target rule for http / https / tls_expiry — the same one the collector applies to every resolved
 * address (internal/watch/guard.go), and the same principle as webhook / e-mail destinations:
 *   - an IPv4 address of the local kind (private, loopback, link-local, CGNAT) must lie inside an
 *     enabled authorized scope of the site;
 *   - a public address is allowed only with the check's explicit allow_public opt-in;
 *   - unspecified, broadcast, multicast and reserved addresses are refused;
 *   - a host name is passed on: the collector resolves it on its own network and refuses the check
 *     when any address it resolves to breaks the rule (the API cannot know internal names).
 */
export async function assertWatchTarget(db: Db, siteId: string, target: string, allowPublic: boolean): Promise<void> {
  if (!isIPv4(target)) return;
  const range = ipaddr.IPv4.parse(target).range();
  if (['unspecified', 'broadcast', 'multicast', 'reserved'].includes(range)) {
    throw new AppError(422, 'out_of_scope', 'This address cannot be a check target (unspecified, broadcast, multicast or reserved)');
  }
  const local = range === 'private' || range === 'loopback' || range === 'linkLocal' || range === 'carrierGradeNat';
  if (!local) {
    if (!allowPublic) {
      throw new AppError(422, 'public_not_allowed', 'This is a public internet address: turn on "allow public host" for this check to reach it');
    }
    return;
  }
  const inScope = await db.query(`SELECT 1 FROM network_scopes WHERE site_id = $1 AND enabled AND $2::inet <<= cidr LIMIT 1`, [siteId, target]);
  if (!inScope.rowCount) throw new AppError(422, 'out_of_scope', 'This address is not inside an authorized network scope of the site');
}

// ───────────────────────── classification ─────────────────────────

export type SampleState = 'ok' | 'degraded' | 'down';

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1));
const COMPARE_TEXT: Record<Comparison, string> = { gt: 'above', lt: 'below', eq: 'equal to', ne: 'not equal to' };

export function crosses(comparison: Comparison, value: number, threshold: number): boolean {
  switch (comparison) {
    case 'gt':
      return value > threshold;
    case 'lt':
      return value < threshold;
    case 'eq':
      return value === threshold;
    case 'ne':
      return value !== threshold;
  }
}

/**
 * Classifies the measured value of a successful sample of a watch check. Deterministic; the reasons
 * are stored with the state-change event as evidence. Returns null when the kind has no value thresholds.
 */
export function classifyValue(kind: string, config: Record<string, unknown>, value: number | undefined): { state: SampleState; reasons: string[] } | null {
  if (kind === 'tls_expiry') {
    if (value === undefined) return { state: 'down', reasons: ['The collector reported no certificate expiry'] };
    const c = config as Partial<TlsConfig>;
    const critical = c.critical_days ?? 7;
    const warn = c.warn_days ?? 30;
    const text = value < 0 ? `The certificate expired ${fmt(-value)} days ago` : `The certificate expires in ${fmt(value)} days`;
    if (value <= critical) return { state: 'down', reasons: [`${text} (critical at ${critical} days or fewer)`] };
    if (value <= warn) return { state: 'degraded', reasons: [`${text} (warning at ${warn} days or fewer)`] };
    return { state: 'ok', reasons: [] };
  }
  if (kind === 'snmp_oid') {
    if (value === undefined) return { state: 'down', reasons: ['The device returned no numeric value for the OID'] };
    const c = config as Partial<SnmpConfig>;
    const cmp = (c.comparison ?? 'gt') as Comparison;
    const unit = c.unit ? ` ${c.unit}` : '';
    if (c.critical !== null && c.critical !== undefined && crosses(cmp, value, c.critical)) {
      return { state: 'down', reasons: [`Value ${fmt(value)}${unit} is ${COMPARE_TEXT[cmp]} the critical threshold ${fmt(c.critical)}${unit}`] };
    }
    if (c.warn !== null && c.warn !== undefined && crosses(cmp, value, c.warn)) {
      return { state: 'degraded', reasons: [`Value ${fmt(value)}${unit} is ${COMPARE_TEXT[cmp]} the warning threshold ${fmt(c.warn)}${unit}`] };
    }
    return { state: 'ok', reasons: [] };
  }
  return null;
}

/**
 * The SNMP presets offered by the UI. Every OID is a published standard or vendor MIB object; which
 * ones a given device implements varies, so each carries an honest note. Index placeholders
 * ({index}) are filled in by the administrator (the UI explains where to find the index).
 */
export const SNMP_PRESET_CATALOG = [
  {
    preset: 'cpu',
    oid: '.1.3.6.1.2.1.25.3.3.1.2.{index}',
    comparison: 'gt',
    warn: 80,
    critical: 95,
    unit: '%',
    note: 'HOST-RESOURCES-MIB hrProcessorLoad (per processor, 1-minute average). Implemented by Linux net-snmp, Windows, MikroTik RouterOS and many NAS devices. Cisco IOS uses CISCO-PROCESS-MIB cpmCPUTotal5minRev (.1.3.6.1.4.1.9.9.109.1.1.1.1.8.{index}) instead.',
  },
  {
    preset: 'memory',
    oid: '.1.3.6.1.2.1.25.2.3.1.6.{index}',
    ratio_oid: '.1.3.6.1.2.1.25.2.3.1.5.{index}',
    comparison: 'gt',
    warn: 85,
    critical: 95,
    unit: '%',
    note: 'HOST-RESOURCES-MIB hrStorageUsed / hrStorageSize of one storage entry, as a percentage. The physical-memory entry index differs per device (often 1 on net-snmp, 65536 on MikroTik); look it up in hrStorageDescr (.1.3.6.1.2.1.25.2.3.1.3). Many switches do not implement this table.',
  },
  {
    preset: 'temperature',
    oid: '.1.3.6.1.2.1.99.1.1.1.4.{index}',
    comparison: 'gt',
    warn: 60,
    critical: 75,
    unit: '°C',
    note: 'ENTITY-SENSOR-MIB entPhySensorValue. The value may be scaled (entPhySensorScale / entPhySensorPrecision): set the multiplier accordingly. MikroTik reports mtxrHlTemperature (.1.3.6.1.4.1.14988.1.1.3.10.0) in tenths of a degree (multiplier 0.1); many small switches expose no temperature at all.',
  },
  {
    preset: 'link_status',
    oid: '.1.3.6.1.2.1.2.2.1.8.{index}',
    comparison: 'ne',
    warn: null,
    critical: 1,
    unit: '',
    note: 'IF-MIB ifOperStatus of one interface (1 = up, 2 = down, 7 = lowerLayerDown). Standard on every SNMP switch and router; the index is the ifIndex shown in Port Detective.',
  },
] as const;
