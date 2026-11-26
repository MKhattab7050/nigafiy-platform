import { createCipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import type { NotificationAction } from '@nigafiy/shared-types/notification-actions';
import { SignJWT, importJWK, type JWK } from 'jose';
import { decryptSecret, encryptSecret } from '../../common/crypto.ts';
import { isPublicAddress } from '../../common/net.ts';
import { env } from '../../config/env.ts';
import { withSystem } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import type { NotificationEvent } from './email.ts';

// Web Push for the installable web app (UX review 2026-11-26, item 11; migration 059).
//
// Standards only, no outside account and no extra package:
//  * RFC 8291 message encryption (aes128gcm, RFC 8188) with node:crypto: only the subscribed browser
//    can read the message; the push service (Google, Mozilla, Apple, Microsoft) sees ciphertext.
//  * RFC 8292 VAPID: the installation signs each request with its own P-256 key (generated once,
//    private key sealed with APP_ENCRYPTION_KEY in webpush_vapid).
//  * The server POSTs only to the known push services' hosts over HTTPS, after checking the name
//    resolves to public addresses, pinned to the address it checked (no SSRF through a crafted
//    "subscription").

const b64u = (buf: Uint8Array): string => Buffer.from(buf).toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

// ─────────────────────────── push service hosts ───────────────────────────

/** Push services the browsers use. A subscription endpoint must be HTTPS on one of these. */
const PUSH_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Samsung Internet, Opera
  /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/, // Firefox
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/, // Edge on Windows (WNS)
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/, // Safari, iPhone home-screen apps (iOS 16.4+)
];

export function validPushEndpoint(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname.toLowerCase()))) return null;
  return url;
}

// ─────────────────────────── RFC 8291 encryption ───────────────────────────

export interface PushKeys {
  /** The browser's P-256 public key, uncompressed (65 bytes), base64url. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

/** Throws when the keys are not a usable P-256 point and a 16-byte secret. */
export function checkPushKeys(keys: PushKeys): void {
  const pub = fromB64u(keys.p256dh);
  const auth = fromB64u(keys.auth);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('p256dh is not an uncompressed P-256 public key');
  if (auth.length !== 16) throw new Error('auth is not 16 bytes');
  // computeSecret rejects a point that is not on the curve.
  const probe = createECDH('prime256v1');
  probe.generateKeys();
  probe.computeSecret(pub);
}

const RECORD_SIZE = 4096;

/**
 * Encrypts one push message (RFC 8291 §3.4, content coding aes128gcm, a single record).
 * `salt` and `asKeys` are parameters only so the test can use the RFC's example values.
 */
export function encryptPushPayload(
  plaintext: Buffer,
  keys: PushKeys,
  salt: Buffer = randomBytes(16),
  asKeys?: { privateKey: Buffer; publicKey: Buffer },
): Buffer {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  const ecdh = createECDH('prime256v1');
  if (asKeys) ecdh.setPrivateKey(asKeys.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error('push message too large');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the padding delimiter of the last (only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// ─────────────────────────── VAPID (RFC 8292) ───────────────────────────

interface Vapid {
  publicKey: string;
  privateJwk: JWK;
}
let cachedVapid: Vapid | null = null;

/** The installation's VAPID key pair; made on first use (race-safe: the first insert wins). */
export async function vapidKeys(): Promise<Vapid> {
  if (cachedVapid) return cachedVapid;
  const row = await withSystem(async (db) => {
    const existing = (await db.query<{ public_key: string; private_key_sealed: string }>(`SELECT public_key, private_key_sealed FROM webpush_vapid`)).rows[0];
    if (existing) return existing;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' }) as JWK;
    const publicKey = b64u(Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x ?? ''), fromB64u(jwk.y ?? '')]));
    await db.query(`INSERT INTO webpush_vapid (id, public_key, private_key_sealed) VALUES (true, $1, $2) ON CONFLICT (id) DO NOTHING`, [
      publicKey,
      encryptSecret(JSON.stringify(jwk)),
    ]);
    return (await db.query<{ public_key: string; private_key_sealed: string }>(`SELECT public_key, private_key_sealed FROM webpush_vapid`)).rows[0]!;
  });
  cachedVapid = { publicKey: row.public_key, privateJwk: JSON.parse(decryptSecret(row.private_key_sealed)) as JWK };
  return cachedVapid;
}

/** Forget the cached key (key rotation re-seals it; tests reset the table). */
export function resetVapidCache(): void {
  cachedVapid = null;
}

/**
 * The VAPID contact ("sub"). Push services want an https: URL or a mailto:. This installation's own
 * address when it is HTTPS; otherwise a fixed local mailto (no personal address is sent anywhere).
 */
function vapidSubject(): string {
  const base = (env.PUBLIC_URL || env.WEB_ORIGIN || '').replace(/\/+$/, '');
  return base.startsWith('https://') ? base : 'mailto:notifications@nigafiy.local';
}

export async function vapidAuthorization(endpoint: URL, now = Date.now()): Promise<string> {
  const vapid = await vapidKeys();
  const key = await importJWK(vapid.privateJwk, 'ES256');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setAudience(endpoint.origin)
    .setExpirationTime(Math.floor(now / 1000) + 12 * 3600)
    .setSubject(vapidSubject())
    .sign(key);
  return `vapid t=${jwt}, k=${vapid.publicKey}`;
}

// ─────────────────────────── the message ───────────────────────────

export type PushLanguage = 'en' | 'ar';

/** What the service worker (apps/web/public/sw.js) receives. */
export interface PushMessage {
  title: string;
  body: string;
  /** Same-origin path to open on a tap. */
  url: string;
  /** Repeats of the same device + type replace each other on the phone. */
  tag: string;
  severity: string;
  lang: PushLanguage;
  /** At most two buttons (what Android and desktop browsers show). */
  actions: { id: string; title: string; token?: string; path?: string }[];
  /** Shown by the worker after a button worked or failed. */
  done: { allow_device: string; pause_device: string; failed: string };
}

const DONE = {
  en: { allow_device: 'Allowed. The device is now marked as known.', pause_device: 'Paused. Open Nigafiy to resume it any time.', failed: 'That did not work. Open Nigafiy to try again.' },
  ar: { allow_device: 'تم السماح. أصبح الجهاز معروفاً.', pause_device: 'تم الإيقاف المؤقت. افتح Nigafiy لاستئنافه في أي وقت.', failed: 'لم ينجح ذلك. افتح Nigafiy وحاول مرة أخرى.' },
} as const;

/** The page that shows an event, as a same-origin path (mirrors eventPageUrl). */
function eventPath(event: NotificationEvent): string {
  const uuid = /^[0-9a-f-]{36}$/i;
  if (event.device_id && uuid.test(event.device_id)) return `/radar/devices/${event.device_id}`;
  if (event.check_id && uuid.test(event.check_id)) return '/watch/monitoring';
  return `/watch/events?type=${encodeURIComponent(event.type)}`;
}

function detailLines(details: Record<string, unknown>, max: number): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(details)) {
    if (k === 'actions' || v === null || v === undefined || typeof v === 'object') continue;
    out.push(`${k.replaceAll('_', ' ')}: ${String(v).slice(0, 80)}`);
    if (out.length >= max) break;
  }
  return out;
}

export function buildPushMessage(event: NotificationEvent & { actions?: NotificationAction[] }, organizationName: string, lang: PushLanguage): PushMessage {
  const where = event.site_name ? `${organizationName} / ${event.site_name}` : organizationName;
  const body = [where, ...detailLines(event.details ?? {}, 3)].join('\n').slice(0, 600);
  const buttons = (event.actions ?? []).filter((a) => a.token || (a.kind === 'open' && a.path));
  // Buttons that act come first; "Open" is also what a tap on the notification does.
  buttons.sort((a, b) => Number(Boolean(b.token)) - Number(Boolean(a.token)));
  return {
    title: event.title.slice(0, 120),
    body,
    url: eventPath(event),
    tag: `${event.type}:${event.device_id ?? event.check_id ?? event.id}`.slice(0, 120),
    severity: event.severity,
    lang,
    actions: buttons.slice(0, 2).map((a, i) => ({
      id: `${a.kind}-${i}`,
      title: a.label[lang],
      ...(a.token ? { token: a.token } : {}),
      ...(a.path ? { path: a.path } : {}),
    })),
    done: DONE[lang],
  };
}

// ─────────────────────────── sending ───────────────────────────

export interface PushRequest {
  endpoint: URL;
  headers: Record<string, string>;
  body: Buffer;
}

/** Sends one request and returns the HTTP status. Replaced in tests (no real network). */
export const pushTransport = {
  send: async (req: PushRequest): Promise<number> => {
    const host = req.endpoint.hostname;
    const addresses = await lookup(host, { all: true });
    const target = addresses[0];
    if (!target) throw new Error('push service name did not resolve');
    if (addresses.some((a) => !isPublicAddress(a.address))) throw new Error('push service resolved to a private address');
    const pinned = (_h: string, _o: unknown, cb: (err: Error | null, address: string, family: number) => void) => cb(null, target.address, target.family);
    return new Promise<number>((resolve, reject) => {
      const r = https.request(req.endpoint, { method: 'POST', headers: req.headers, timeout: 10_000, lookup: pinned as never }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      r.on('timeout', () => r.destroy(new Error('timed out')));
      r.on('error', reject);
      r.end(req.body);
    });
  },
};

export interface StoredSubscription {
  endpoint: string;
  keys: PushKeys;
}

/** Encrypts and sends one message to one browser. Returns the push service's HTTP status. */
export async function sendPush(sub: StoredSubscription, message: PushMessage): Promise<number> {
  const endpoint = validPushEndpoint(sub.endpoint);
  if (!endpoint) throw new Error('not a known push service address');
  const body = encryptPushPayload(Buffer.from(JSON.stringify(message)), sub.keys);
  return pushTransport.send({
    endpoint,
    body,
    headers: {
      Authorization: await vapidAuthorization(endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      TTL: String(24 * 3600),
      Urgency: message.severity === 'critical' ? 'high' : message.severity === 'warning' ? 'normal' : 'low',
      'User-Agent': 'Nigafiy-Notifications/1',
    },
  });
}

/**
 * Delivers one notification delivery of a 'push' channel to every browser subscribed to it.
 * Returns null when at least one browser got it, else the reason (the dispatcher retries).
 * A subscription the push service says is gone (404 / 410) is deleted.
 */
export async function deliverPush(deliveryId: string, event: NotificationEvent & { actions?: NotificationAction[] }, organizationName: string): Promise<string | null> {
  const subs = await withSystem(
    async (db) =>
      (
        await db.query<{ id: string; subscription_sealed: string; language: PushLanguage }>(
          `SELECT s.id, s.subscription_sealed, s.language
             FROM notification_deliveries d JOIN webpush_subscriptions s ON s.channel_id = d.channel_id AND s.organization_id = d.organization_id
            WHERE d.id = $1 ORDER BY s.created_at`,
          [deliveryId],
        )
      ).rows,
  );
  if (!subs.length) return 'no phone or browser has push turned on (Settings → Notifications → Phone notifications)';

  let delivered = 0;
  let firstError: string | null = null;
  for (const s of subs) {
    let error: string | null = null;
    let gone = false;
    try {
      const sub = JSON.parse(decryptSecret(s.subscription_sealed)) as StoredSubscription;
      const status = await sendPush(sub, buildPushMessage(event, organizationName, s.language));
      if (status === 404 || status === 410) gone = true;
      else if (status < 200 || status >= 300) error = `push service responded with HTTP ${status}`;
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, ' ').slice(0, 200);
    }
    await withSystem(async (db) => {
      if (gone) await db.query(`DELETE FROM webpush_subscriptions WHERE id = $1`, [s.id]);
      else if (error) await db.query(`UPDATE webpush_subscriptions SET last_error = $2 WHERE id = $1`, [s.id, error]);
      else await db.query(`UPDATE webpush_subscriptions SET last_success_at = now(), last_error = NULL WHERE id = $1`, [s.id]);
    });
    if (gone) {
      logger.info({ subscription_id: s.id }, 'push subscription ended; removed');
      firstError ??= 'the browser turned push off (subscription removed)';
    } else if (error) firstError ??= error;
    else delivered += 1;
  }
  return delivered > 0 ? null : firstError;
}
