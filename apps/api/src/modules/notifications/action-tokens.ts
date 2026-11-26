import type { NotificationAction, NotificationActionKind } from '@nigafiy/shared-types/notification-actions';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { randomToken, sha256 } from '../../common/crypto.ts';
import { AppError, parse } from '../../common/http.ts';
import { env } from '../../config/env.ts';
import { type Db, withSystem, withTenant } from '../../infrastructure/db.ts';
import { limiterStore } from '../../infrastructure/rate-limit.ts';
import { setDeviceInternetPause } from '../access/index.ts';
import { setDeviceTrust } from '../devices/index.ts';

// Buttons on notifications (UX review 2026-11-26, item 9; migration 056).
//
// An event that offers buttons stores them WITHOUT tokens in `details.actions` (what the app shows a
// signed-in user, who presses them with the normal session routes: PATCH /devices/:id { trust },
// POST /devices/:id/pause). Each delivery to a channel gets its own tokens, minted when it is sent
// (deliveryActions), so a token never sits in the event timeline that every viewer can read.
//
// POST /api/v1/notification-actions/:token is reached from Telegram, push and email without a session:
// the token is the only authority. A token is random (32 bytes), stored as its SHA-256, bound to one
// organization + device + kind, works once and expires 24 h after it was issued. The action is
// audited as the organization owner's (the person the notifications are for), with the channel,
// the event and the caller's address. GET only describes the token and never acts (link scanners
// and mail previews fetch links); the email landing page asks before it POSTs.

export const ACTION_TOKEN_HOURS = 24;
/** "Pause" from a notification: the longest pause POST /devices/:id/pause allows (7 days). Resume any time in the app. */
export const NOTIFICATION_PAUSE_MINUTES = 7 * 24 * 60;

const TOKEN_KINDS = ['allow_device', 'pause_device'] as const;
type TokenKind = (typeof TOKEN_KINDS)[number];
const isTokenKind = (k: NotificationActionKind): k is TokenKind => (TOKEN_KINDS as readonly string[]).includes(k);

/** The web page an email link opens: it shows what the button does and asks before acting. */
export const actionLandingPath = (token: string): string => `/notification-action/${token}`;

/** The buttons of a "New device joined" event, without tokens (stored in the event's details.actions). */
export function newDeviceActions(deviceId: string): NotificationAction[] {
  return [
    { kind: 'allow_device', label: { en: 'Allow', ar: 'السماح' } },
    { kind: 'pause_device', label: { en: 'Pause', ar: 'إيقاف مؤقت' } },
    { kind: 'open', label: { en: 'Open', ar: 'فتح' }, path: `/radar/devices/${deviceId}` },
  ];
}

/**
 * Give each button that acts (allow / pause) a fresh single-use token, inside the caller's transaction.
 * Throws when the device is not the organization's (the token table's foreign key).
 */
export async function issueActionTokens(
  db: Db,
  organizationId: string,
  deviceId: string,
  actions: readonly NotificationAction[],
  ref: { eventId?: string | null; channelId?: string | null } = {},
  now = new Date(),
): Promise<NotificationAction[]> {
  const expires = new Date(now.getTime() + ACTION_TOKEN_HOURS * 3600_000);
  const out: NotificationAction[] = [];
  for (const a of actions) {
    if (!isTokenKind(a.kind)) {
      out.push({ kind: a.kind, label: a.label, ...(a.path ? { path: a.path } : {}) });
      continue;
    }
    const token = randomToken(32);
    await db.query(
      `INSERT INTO notification_action_tokens (token_hash, organization_id, device_id, kind, event_id, channel_id, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sha256(token), organizationId, deviceId, a.kind, ref.eventId ?? null, ref.channelId ?? null, now, expires],
    );
    out.push({ kind: a.kind, label: a.label, token });
  }
  return out;
}

/**
 * The buttons for one notification delivery, with tokens minted for that channel; undefined when the
 * event carries none. Called by the dispatcher just before it sends (each attempt mints new tokens;
 * unused ones simply expire).
 */
export async function deliveryActions(deliveryId: string): Promise<NotificationAction[] | undefined> {
  return withSystem(async (db) => {
    const row = (
      await db.query<{ organization_id: string; channel_id: string; event_id: string; device_id: string | null; actions: NotificationAction[] | null }>(
        `SELECT d.organization_id, d.channel_id, d.event_id, e.device_id, e.details -> 'actions' AS actions
           FROM notification_deliveries d JOIN network_events e ON e.id = d.event_id WHERE d.id = $1`,
        [deliveryId],
      )
    ).rows[0];
    if (!row?.device_id || !Array.isArray(row.actions) || !row.actions.length) return undefined;
    const exists = await db.query(`SELECT 1 FROM devices WHERE id = $1 AND organization_id = $2`, [row.device_id, row.organization_id]);
    if (!exists.rowCount) return undefined;
    return issueActionTokens(db, row.organization_id, row.device_id, row.actions, { eventId: row.event_id, channelId: row.channel_id });
  });
}

interface TokenRow {
  organization_id: string;
  device_id: string;
  kind: TokenKind;
  event_id: string | null;
  channel_id: string | null;
  expires_at: Date;
  used_at: Date | null;
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,64}$/;
const gone = (code: 'action_used' | 'action_expired') =>
  new AppError(
    410,
    code,
    code === 'action_used' ? 'This button was already used. Open Nigafiy to change the device.' : 'This button has expired (after 24 hours). Open Nigafiy to change the device.',
  );

async function lookup(token: string): Promise<TokenRow & { device_label: string; device_ip: string | null; device_mac: string | null; trust: string; paused_until: Date | null }> {
  if (!TOKEN_SHAPE.test(token)) throw new AppError(404, 'not_found', 'This button is not valid');
  const row = await withSystem(
    async (db) =>
      (
        await db.query<TokenRow & { device_label: string; device_ip: string | null; device_mac: string | null; trust: string; paused_until: Date | null }>(
          `SELECT t.organization_id, t.device_id, t.kind, t.event_id, t.channel_id, t.expires_at, t.used_at,
                  coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text, 'Device') AS device_label,
                  host(d.current_ip) AS device_ip, d.primary_mac::text AS device_mac, d.trust, d.internet_paused_until AS paused_until
             FROM notification_action_tokens t JOIN devices d ON d.id = t.device_id AND d.organization_id = t.organization_id
            WHERE t.token_hash = $1`,
          [sha256(token)],
        )
      ).rows[0],
  );
  if (!row) throw new AppError(404, 'not_found', 'This button is not valid');
  return row;
}

export interface ActionTokenInfo {
  kind: TokenKind;
  device: { id: string; label: string; ip: string | null; mac: string | null; trust: string; paused_until: string | null };
  expires_at: string;
  used: boolean;
  expired: boolean;
  /** For pause: how long the pause lasts. */
  pause_minutes: number | null;
}

/** GET: what the button would do. Never changes anything (link scanners and previews fetch links). */
export async function describeActionToken(token: string, now = new Date()): Promise<ActionTokenInfo> {
  const t = await lookup(token);
  return {
    kind: t.kind,
    device: { id: t.device_id, label: t.device_label, ip: t.device_ip, mac: t.device_mac, trust: t.trust, paused_until: t.paused_until?.toISOString() ?? null },
    expires_at: t.expires_at.toISOString(),
    used: t.used_at !== null,
    expired: t.expires_at.getTime() <= now.getTime(),
    pause_minutes: t.kind === 'pause_device' ? NOTIFICATION_PAUSE_MINUTES : null,
  };
}

export interface ActionResult {
  kind: TokenKind;
  device: { id: string; label: string };
  trust?: string;
  paused_until?: string;
}

/**
 * POST: use the token once. Everything (marking the token used, the action, the audit record) commits
 * together, so a failed action leaves the token usable.
 */
export async function redeemActionToken(
  token: string,
  ip: string | null,
  now = new Date(),
  opts: { channelId?: string; via?: Record<string, string> } = {},
): Promise<ActionResult> {
  const t = await lookup(token);
  // A Telegram button press counts only for the channel the token was sent to.
  if (opts.channelId && t.channel_id !== opts.channelId) throw new AppError(404, 'not_found', 'This button is not valid');
  if (t.used_at) throw gone('action_used');
  if (t.expires_at.getTime() <= now.getTime()) throw gone('action_expired');
  const owner = await withSystem(
    async (db) =>
      (
        await db.query<{ id: string; email: string }>(
          `SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = $1 AND m.role = 'owner' ORDER BY m.created_at LIMIT 1`,
          [t.organization_id],
        )
      ).rows[0] ?? null,
  );
  return withTenant(t.organization_id, async (db) => {
    // Single use, race-safe: only one request can flip used_at.
    const claimed = await db.query(
      `UPDATE notification_action_tokens SET used_at = $2, used_ip = $3
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
      [sha256(token), now, ip],
    );
    if (!claimed.rowCount) throw gone('action_used');
    const via = { ...opts.via, via: 'notification_action', kind: t.kind, channel_id: t.channel_id, event_id: t.event_id };
    const auditAs = async (action: string, metadata: Record<string, unknown>) =>
      db.query(
        `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
         VALUES ($1,$2,$3,$4,'device',$5,$6,$7)`,
        [t.organization_id, owner?.id ?? null, owner?.email ?? null, action, t.device_id, JSON.stringify({ ...metadata, ...via }), ip],
      );
    if (t.kind === 'allow_device') {
      const r = await setDeviceTrust(db, t.organization_id, t.device_id, 'known');
      await auditAs('device.updated', { fields: ['trust'], trust: 'known', previous: r.previous });
      return { kind: t.kind, device: { id: t.device_id, label: t.device_label }, trust: 'known' };
    }
    const until = new Date(now.getTime() + NOTIFICATION_PAUSE_MINUTES * 60_000);
    // The same path as POST /devices/:id/pause: the DNS-filter pause plus the router's block where one can block.
    await setDeviceInternetPause(db, t.organization_id, t.device_id, until);
    await auditAs('device.internet.pause', { until });
    return { kind: t.kind, device: { id: t.device_id, label: t.device_label }, paused_until: until.toISOString() };
  });
}

const tokenParams = z.object({ token: z.string().max(100) });

// Per caller address: enough for someone pressing buttons, far too few to guess a 256-bit token.
const limiter = rateLimit({
  store: limiterStore('notification-actions'),
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' } },
});

/** Mounted WITHOUT a session at /api/v1/notification-actions (publicApi). The token is the authority; no cookie is read. */
export const notificationActionsRouter: Router = Router();
notificationActionsRouter.use(limiter);

notificationActionsRouter.get('/:token', async (req, res) => {
  const { token } = parse(tokenParams, req.params);
  res.set('Cache-Control', 'no-store');
  res.json(await describeActionToken(token));
});

notificationActionsRouter.post('/:token', async (req, res) => {
  const { token } = parse(tokenParams, req.params);
  res.set('Cache-Control', 'no-store');
  res.json(await redeemActionToken(token, req.ip ?? null));
});
