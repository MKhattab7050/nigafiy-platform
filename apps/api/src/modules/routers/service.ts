import type { Request } from 'express';
import { audit } from '../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { sealRouterCredentials } from './credentials.ts';
import { MAX_ROUTERS_PER_SITE, REQUEST_TTL_MINUTES, type RouterCreate, type RouterPatch, canonicalPin } from './schema.ts';

// Router management and administrator requests. Every write is audited; credentials are never
// returned, logged or audited (only "credentials changed: true"). `req` is passed for the audit trail.

export type RouterAction =
  | 'refresh'
  | 'fetch_certificate'
  | 'block'
  | 'unblock'
  | 'rate_limit'
  | 'clear_rate_limit'
  | 'schedule'
  | 'clear_schedule'
  | 'rename'
  | 'wifi'
  | 'reserve'
  | 'unreserve'
  | 'add_port_forward'
  | 'remove_port_forward'
  | 'reboot';

const COMMAND_KIND: Record<RouterAction, string> = {
  refresh: 'router_refresh',
  fetch_certificate: 'router_fetch_certificate',
  block: 'router_block',
  unblock: 'router_unblock',
  rate_limit: 'router_rate_limit',
  clear_rate_limit: 'router_rate_limit',
  schedule: 'router_schedule',
  clear_schedule: 'router_schedule',
  rename: 'router_rename',
  wifi: 'router_wifi',
  reserve: 'router_reservation',
  unreserve: 'router_reservation',
  add_port_forward: 'router_port_forward',
  remove_port_forward: 'router_port_forward',
  reboot: 'router_reboot',
};

/** Actions whose command carries `clear: true` (the same command kind removes instead of sets). */
const CLEARING: ReadonlySet<RouterAction> = new Set(['clear_rate_limit', 'clear_schedule', 'unreserve', 'remove_port_forward']);

export interface CapabilityStatus {
  capability: string;
  supported: boolean;
  mechanism?: string;
  note?: string;
}

export interface RouterRow {
  id: string;
  site_id: string;
  device_id: string | null;
  name: string;
  vendor: string;
  address: string;
  port: number | null;
  transport: 'https' | 'https-pinned' | 'http';
  pin_sha256: string | null;
  pinned_at: Date | null;
  enabled: boolean;
  refresh_interval_seconds: number;
  status: string;
  last_error: string | null;
  last_error_kind: string | null;
  last_checked_at: Date | null;
  last_ok_at: Date | null;
  login_paused_until: Date | null;
  login_paused_reason: 'bad_credentials' | 'locked_out' | null;
  identity: Record<string, unknown> | null;
  capabilities: CapabilityStatus[] | null;
  clients_refreshed_at: Date | null;
  client_count: number;
  credentials_updated_at: Date;
  in_scope: boolean;
  created_at: Date;
  updated_at: Date;
}

export const ROUTER_SELECT = `
  SELECT r.id, r.site_id, r.device_id, r.name, r.vendor, host(r.address) AS address, r.port, r.transport, r.pin_sha256, r.pinned_at, r.enabled,
         r.refresh_interval_seconds, r.status, r.last_error, r.last_error_kind, r.last_checked_at, r.last_ok_at, r.login_paused_until, r.login_paused_reason,
         r.identity, r.capabilities, r.clients_refreshed_at, r.credentials_updated_at, r.created_at, r.updated_at,
         (SELECT count(*)::int FROM router_clients c WHERE c.router_id = r.id) AS client_count,
         EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = r.site_id AND s.enabled AND r.address <<= s.cidr) AS in_scope
    FROM site_routers r`;

/** Whether logins to the router are paused (lockout protection), and why. */
export function loginPause(r: Pick<RouterRow, 'login_paused_reason' | 'login_paused_until'>, now = new Date()): { paused: boolean; reason: string | null; until: Date | null } {
  if (r.login_paused_reason === 'bad_credentials') return { paused: true, reason: 'bad_credentials', until: null };
  if (r.login_paused_until && r.login_paused_until > now) return { paused: true, reason: r.login_paused_reason ?? 'locked_out', until: r.login_paused_until };
  return { paused: false, reason: null, until: null };
}

/** Why the collector does (not) receive this router: drives "what is going on" in the UI. */
export function delivery(r: RouterRow, now = new Date()): 'active' | 'disabled' | 'out_of_scope' | 'awaiting_certificate' | 'login_paused' {
  if (!r.enabled) return 'disabled';
  if (!r.in_scope) return 'out_of_scope';
  if (r.transport === 'https-pinned' && !r.pin_sha256) return 'awaiting_certificate';
  if (loginPause(r, now).paused) return 'login_paused';
  return 'active';
}

/** The public representation. Credentials are write-only: only whether and when they were set. */
export function present(r: RouterRow) {
  const pause = loginPause(r);
  return {
    ...r,
    credentials: { set: true, updated_at: r.credentials_updated_at },
    credentials_updated_at: undefined,
    login_paused: pause.paused,
    login_paused_reason: pause.reason,
    login_paused_until: pause.until,
    delivery: delivery(r),
  };
}

export async function loadRouter(db: Db, id: string, lock = false): Promise<RouterRow> {
  const r = (await db.query<RouterRow>(`${ROUTER_SELECT} WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`, [id])).rows[0];
  if (!r) throw notFound('Router');
  return r;
}

/** Requests not answered in time expire (like wake requests): acting long after someone asked is not what they wanted. */
export async function expireStaleRequests(db: Db): Promise<void> {
  await db.query(
    `UPDATE router_requests SET status = 'expired', error = 'The collector did not report a result in time', error_kind = 'expired', completed_at = now()
      WHERE status = 'pending' AND created_at < now() - make_interval(mins => $1)`,
    [REQUEST_TTL_MINUTES],
  );
}

export function listRouters(organizationId: string, siteId: string | undefined) {
  return withTenant(organizationId, async (db) =>
    (await db.query<RouterRow>(`${ROUTER_SELECT} WHERE ($1::uuid IS NULL OR r.site_id = $1) ORDER BY r.name, r.address`, [siteId ?? null])).rows.map(present),
  );
}

export function routerDetail(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    await expireStaleRequests(db);
    const r = await loadRouter(db, id);
    const extra = (
      await db.query<{ blocked_entries: unknown; fetched_certificate: unknown; certificate_fetched_at: Date | null }>(
        `SELECT blocked_entries, fetched_certificate, certificate_fetched_at FROM site_routers WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
    const ledger = (
      await db.query(
        `SELECT b.id, b.mac::text AS mac, b.device_id, b.mechanism, b.pre_existing, b.applied_by_email, b.applied_at, b.undo,
                b.released_at, b.released_by_email, b.released_via
           FROM router_blocks b WHERE b.router_id = $1 ORDER BY b.released_at IS NULL DESC, b.applied_at DESC LIMIT 200`,
        [id],
      )
    ).rows;
    const requests = (
      await db.query(
        `SELECT id, action, mac::text AS mac, device_id, params, status, result, error, error_kind, created_by_email, created_at, completed_at
           FROM router_requests WHERE router_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [id],
      )
    ).rows;
    return {
      ...present(r),
      blocked_entries: extra.blocked_entries,
      certificate: { pinned: r.pin_sha256, pinned_at: r.pinned_at, fetched: extra.fetched_certificate, fetched_at: extra.certificate_fetched_at },
      blocks: ledger,
      recent_requests: requests,
    };
  });
}

export function routerClients(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    const r = await loadRouter(db, id);
    const items = (
      await db.query(
        `SELECT c.mac::text AS mac, host(c.ip) AS ip, c.hostname, c.connection, c.interface, c.signal_dbm, c.active, c.lease_source, c.lease_remaining_seconds,
                c.blocked, c.raw, c.first_seen_at, c.last_seen_at, c.device_id,
                coalesce(d.display_name, d.hostname, host(d.current_ip)) AS device_label, d.trust AS device_trust,
                (SELECT jsonb_build_object('id', b.id, 'pre_existing', b.pre_existing, 'applied_by_email', b.applied_by_email, 'applied_at', b.applied_at)
                   FROM router_blocks b WHERE b.router_id = c.router_id AND b.mac = c.mac AND b.released_at IS NULL) AS ledger
           FROM router_clients c LEFT JOIN devices d ON d.id = c.device_id
          WHERE c.router_id = $1 ORDER BY c.ip NULLS LAST, c.mac`,
        [id],
      )
    ).rows.map((c) => ({ ...c, device_link: c.device_id ? 'inferred_by_mac' : null }));
    return { router_id: r.id, refreshed_at: r.clients_refreshed_at, items };
  });
}

export function requestStatus(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    await expireStaleRequests(db);
    const row = (
      await db.query(
        `SELECT id, router_id, site_id, collector_id, action, mac::text AS mac, device_id, params, status, result, error, error_kind, created_by_email, created_at, completed_at
           FROM router_requests WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) throw notFound('Router request');
    return row;
  });
}

async function checkInScope(db: Db, siteId: string, address: string): Promise<void> {
  const inScope = await db.query(`SELECT 1 FROM network_scopes WHERE site_id = $1 AND enabled AND $2::inet <<= cidr`, [siteId, address]);
  if (!inScope.rowCount) throw new AppError(422, 'not_in_scope', 'This address is not inside an authorized network range of the site');
}

export function addRouter(req: Request, ctx: AuthContext, body: RouterCreate) {
  return withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount) throw notFound('Site');
    // Same boundary as discovery and SNMP: a private address inside a range the organization authorized
    // (scopes themselves can only be RFC 1918 ranges; the collector re-checks both).
    await checkInScope(db, body.site_id, body.address);
    const count = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM site_routers WHERE site_id = $1`, [body.site_id])).rows[0]!.n;
    if (count >= MAX_ROUTERS_PER_SITE) throw new AppError(409, 'limit_reached', `A site can have at most ${MAX_ROUTERS_PER_SITE} routers`);
    if ((await db.query(`SELECT 1 FROM site_routers WHERE site_id = $1 AND address = $2::inet`, [body.site_id, body.address])).rowCount) {
      throw new AppError(409, 'already_added', 'A router with this address is already added to the site');
    }
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO site_routers (organization_id, site_id, device_id, name, vendor, address, port, transport, secret_enc, enabled, refresh_interval_seconds, created_by)
         VALUES ($1,$2,(SELECT id FROM devices WHERE site_id = $2 AND current_ip = $5::inet ORDER BY last_seen_at DESC LIMIT 1),$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [ctx.organizationId, body.site_id, body.name, body.vendor, body.address, body.port, body.transport, sealRouterCredentials(body.credentials), body.enabled, body.refresh_interval_seconds, ctx.userId],
      )
    ).rows[0]!;
    // The audit trail records that credentials were set, never what they are.
    await audit(db, req, 'router.add', { type: 'router', id: row.id }, {
      site_id: body.site_id,
      name: body.name,
      vendor: body.vendor,
      address: body.address,
      port: body.port,
      transport: body.transport,
      credentials: { set: true },
    });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return present(await loadRouter(db, row.id));
  });
}

export function updateRouter(req: Request, ctx: AuthContext, id: string, body: RouterPatch) {
  return withTenant(ctx.organizationId, async (db) => {
    const current = await loadRouter(db, id, true);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (body.name !== undefined) set('name', body.name);
    if (body.port !== undefined) set('port', body.port);
    if (body.enabled !== undefined) set('enabled', body.enabled);
    if (body.refresh_interval_seconds !== undefined) set('refresh_interval_seconds', body.refresh_interval_seconds);
    if (body.transport !== undefined && body.transport !== current.transport) {
      set('transport', body.transport);
      // A pin belongs to https-pinned; switching away drops it, switching back needs a new confirmation.
      sets.push('pin_sha256 = NULL', 'pinned_at = NULL', 'pinned_by = NULL');
    }
    if (body.port !== undefined && body.port !== current.port && body.transport === undefined && current.transport === 'https-pinned') {
      sets.push('pin_sha256 = NULL', 'pinned_at = NULL', 'pinned_by = NULL');
    }
    if (body.credentials) {
      set('secret_enc', sealRouterCredentials(body.credentials));
      // New credentials end the login pause: the administrator fixed what the router rejected.
      sets.push('credentials_updated_at = now()', 'login_paused_until = NULL', 'login_paused_reason = NULL');
    }
    if (sets.length) await db.query(`UPDATE site_routers SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
    const { credentials, ...rest } = body;
    await audit(db, req, 'router.update', { type: 'router', id }, { ...rest, ...(credentials ? { credentials: { changed: true } } : {}) });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return present(await loadRouter(db, id));
  });
}

export async function removeRouter(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const r = await loadRouter(db, id, true);
    const open = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM router_blocks WHERE router_id = $1 AND released_at IS NULL AND NOT pre_existing`, [id])).rows[0]!.n;
    await db.query(`DELETE FROM site_routers WHERE id = $1`, [id]);
    // Blocks LAN Detective applied stay on the router: removing the router from the product does not lift them.
    await audit(db, req, 'router.remove', { type: 'router', id }, { name: r.name, address: r.address, blocks_left_in_place: open });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

async function onlineCollector(db: Db, siteId: string): Promise<{ id: string; name: string } | null> {
  return (
    (
      await db.query<{ id: string; name: string }>(
        `SELECT id, name FROM collectors WHERE site_id = $1 AND status = 'active' AND last_heartbeat_at > now() - interval '2 minutes'
          ORDER BY last_heartbeat_at DESC LIMIT 1`,
        [siteId],
      )
    ).rows[0] ?? null
  );
}

/** Refuses login-requiring requests while the router is not delivered to the collector. */
export function assertControllable(r: RouterRow): void {
  const d = delivery(r);
  if (d === 'active') return;
  const pause = loginPause(r);
  const messages: Record<Exclude<typeof d, 'active'>, string> = {
    disabled: 'The router is disabled in LAN Detective',
    out_of_scope: 'The router address is no longer inside an authorized network range of the site',
    awaiting_certificate: 'Confirm the router’s certificate first (fetch it, check the fingerprint, then trust it)',
    login_paused:
      pause.reason === 'bad_credentials'
        ? 'The router rejected the user name or password. LAN Detective stopped logging in so it cannot lock you out; update the credentials to resume'
        : `The router locked the account after failed logins. LAN Detective waits until ${pause.until?.toISOString()} before logging in again`,
  };
  throw new AppError(409, d === 'login_paused' ? 'router_login_paused' : `router_${d}`, messages[d], d === 'login_paused' ? { reason: pause.reason, until: pause.until } : undefined);
}

export interface QueueOptions {
  mac?: string | null;
  deviceId?: string | null;
  params?: Record<string, unknown>;
}

/** Records a request and queues its command for an online collector of the router's site. */
export async function queueRequest(db: Db, ctx: AuthContext, r: RouterRow, action: RouterAction, opts: QueueOptions = {}): Promise<{ request_id: string; collector: string }> {
  const collector = await onlineCollector(db, r.site_id);
  if (!collector) throw new AppError(409, 'no_collector', 'No collector of this site is online to reach the router');
  const params = opts.params ?? {};
  const request = (
    await db.query<{ id: string }>(
      `INSERT INTO router_requests (organization_id, site_id, router_id, collector_id, action, mac, device_id, params, created_by, created_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [ctx.organizationId, r.site_id, r.id, collector.id, action, opts.mac ?? null, opts.deviceId ?? null, JSON.stringify(params), ctx.userId, ctx.userEmail],
    )
  ).rows[0]!;
  const payload: Record<string, unknown> = { request_id: request.id, router_id: r.id, ...params };
  if (opts.mac) payload.mac = opts.mac;
  if (CLEARING.has(action)) payload.clear = true;
  await db.query(`INSERT INTO collector_commands (organization_id, collector_id, kind, payload, created_by) VALUES ($1,$2,$3,$4,$5)`, [
    ctx.organizationId,
    collector.id,
    COMMAND_KIND[action],
    JSON.stringify(payload),
    ctx.userId,
  ]);
  return { request_id: request.id, collector: collector.name };
}

/** "Test / refresh now": identity, capabilities, client list and blocks in effect. Read-only. */
export function requestRefresh(req: Request, ctx: AuthContext, id: string) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStaleRequests(db);
    const r = await loadRouter(db, id, true);
    assertControllable(r);
    const pending = (await db.query<{ id: string }>(`SELECT id FROM router_requests WHERE router_id = $1 AND action = 'refresh' AND status = 'pending'`, [id])).rows[0];
    if (pending) return { request_id: pending.id, already_pending: true };
    const q = await queueRequest(db, ctx, r, 'refresh');
    await audit(db, req, 'router.refresh', { type: 'router', id }, { request_id: q.request_id });
    return { ...q, already_pending: false };
  });
}

/**
 * Trust on first use, step 1: the collector performs only a TLS handshake with the router and
 * reports its certificate. Nothing is trusted until the administrator confirms the fingerprint.
 */
export function requestCertificate(req: Request, ctx: AuthContext, id: string) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStaleRequests(db);
    const r = await loadRouter(db, id, true);
    if (r.transport === 'http') throw new AppError(409, 'not_tls', 'This router is reached over plain HTTP; there is no certificate to trust');
    if (!r.in_scope) throw new AppError(409, 'router_out_of_scope', 'The router address is not inside an authorized network range of the site');
    const q = await queueRequest(db, ctx, r, 'fetch_certificate', { params: { address: r.address, port: r.port ?? 443 } });
    await audit(db, req, 'router.certificate.fetch', { type: 'router', id }, { request_id: q.request_id });
    return q;
  });
}

/** Trust on first use, step 2: the administrator confirms the fingerprint the collector reported. */
export function trustCertificate(req: Request, ctx: AuthContext, id: string, sha256: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const r = await loadRouter(db, id, true);
    const fetched = (await db.query<{ fetched_certificate: { sha256: string } | null }>(`SELECT fetched_certificate FROM site_routers WHERE id = $1`, [id])).rows[0]!.fetched_certificate;
    if (!fetched) throw new AppError(409, 'no_certificate', 'Fetch the router’s certificate first');
    const pin = canonicalPin(sha256);
    // Only the exact certificate the collector saw can be trusted; a typo or a changed certificate is refused.
    if (pin !== fetched.sha256) throw new AppError(409, 'fingerprint_mismatch', 'This fingerprint is not the one the router presented');
    await db.query(
      `UPDATE site_routers SET transport = 'https-pinned', pin_sha256 = $2, pinned_at = now(), pinned_by = $3, updated_at = now() WHERE id = $1`,
      [id, pin, ctx.userId],
    );
    await audit(db, req, 'router.certificate.trust', { type: 'router', id }, { sha256: pin, previous: r.pin_sha256 });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return present(await loadRouter(db, id));
  });
}
