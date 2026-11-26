import { type CollectorContext, ItemRejected, type RouterResultItem, type RouterSettings } from '../../common/collector-protocol.ts';
import { normalizeMac } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { DEFAULT_LOCKOUT_MINUTES } from './schema.ts';

// Applies router_result telemetry: refresh results (client list, capabilities, blocks in effect),
// administrator requests (block / unblock / rate limit / schedule / certificate) and router health
// with open/close events. Runs inside the telemetry batch's per-item savepoint.

type Status = 'never' | 'ok' | 'unreachable' | 'login_failed' | 'locked_out' | 'certificate' | 'not_authorized' | 'error';
type ErrorKind = NonNullable<RouterResultItem['error']>['kind'];

/** Router health derived from an error. Errors about the request itself (unsupported, not_found, …) leave health unchanged. */
const HEALTH: Partial<Record<ErrorKind, Status>> = {
  unreachable: 'unreachable',
  bad_credentials: 'login_failed',
  no_credentials: 'login_failed',
  locked_out: 'locked_out',
  certificate: 'certificate',
  not_authorized: 'not_authorized',
  protocol: 'error',
  session_limit: 'error',
  session_expired: 'error',
  unknown_vendor: 'error',
};

const LOGIN_STATES: Status[] = ['login_failed', 'locked_out'];

interface Target {
  id: string;
  site_id: string;
  name: string;
  address: string;
  status: Status;
  device_id: string | null;
}

export async function processRouterResult(db: Db, c: CollectorContext, item: RouterResultItem): Promise<void> {
  const at = new Date(item.ts);
  const r = (
    await db.query<Target>(`SELECT id, site_id, name, host(address) AS address, status, device_id FROM site_routers WHERE id = $1 AND site_id = $2 FOR UPDATE`, [
      item.router_id,
      c.siteId,
    ])
  ).rows[0];
  if (!r) throw new ItemRejected('router_result for a router that is not configured for this collector’s site');

  let request: { id: string; action: string; mac: string | null; device_id: string | null; created_by: string | null; created_by_email: string | null } | undefined;
  if (item.request_id) {
    // A late answer to an expired request is still applied: the router may have changed, and the ledger must say so.
    request = (
      await db.query(
        `SELECT id, action, mac::text AS mac, device_id, created_by, created_by_email FROM router_requests
          WHERE id = $1 AND router_id = $2 AND collector_id = $3 AND status IN ('pending', 'expired') FOR UPDATE`,
        [item.request_id, r.id, c.id],
      )
    ).rows[0];
    if (!request) throw new ItemRejected('router_result for a request that does not belong to this collector or is already answered');
    if (request.action !== item.action) throw new ItemRejected('router_result action does not match the request');
  }

  if (item.action === 'fetch_certificate') {
    if (item.ok && item.certificate) {
      await db.query(`UPDATE site_routers SET fetched_certificate = $2, certificate_fetched_at = $3 WHERE id = $1`, [r.id, JSON.stringify(item.certificate), at]);
    }
  } else {
    await applyHealth(db, c, r, item, at);
  }

  if (item.action === 'refresh' && (item.identity || item.capabilities || item.clients || item.blocked)) {
    await applyRefresh(db, c, r, item, at);
  }
  // Settings: from a refresh, and re-read after any control that succeeded.
  if (item.settings && (item.action === 'refresh' || item.ok)) await applySettings(db, r, item.settings, at);
  if (item.ok && (item.action === 'block' || item.action === 'unblock') && request && item.change) {
    await applyBlockChange(db, c, r, item, request, at);
  }

  if (request) {
    const result: Record<string, unknown> = {};
    if (item.change) result.change = item.change;
    if (item.certificate) result.certificate = item.certificate;
    if (item.action === 'refresh') {
      result.identity = item.identity ?? null;
      result.clients = item.clients?.length ?? null;
      result.blocked = item.blocked?.length ?? null;
    }
    if (item.settings) result.settings = Object.keys(item.settings);
    await db.query(
      `UPDATE router_requests SET status = $2, result = $3, error = $4, error_kind = $5, completed_at = $6 WHERE id = $1`,
      [request.id, item.ok ? 'completed' : 'failed', JSON.stringify(result), item.error?.message ?? null, item.error?.kind ?? null, at],
    );
  }
  await notifyRealtime(db, c.organizationId, 'devices');
}

async function applyHealth(db: Db, c: CollectorContext, r: Target, item: RouterResultItem, at: Date): Promise<void> {
  const kind = item.error?.kind;
  // login_suspended: the collector did not contact the router — nothing new is known about it.
  const next: Status | null = item.ok ? 'ok' : kind ? (HEALTH[kind] ?? null) : 'error';
  const sets = ['last_checked_at = $2'];
  const vals: unknown[] = [r.id, at];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (next) set('status', next);
  if (item.ok) {
    sets.push('last_error = NULL', 'last_error_kind = NULL', 'login_paused_until = NULL', 'login_paused_reason = NULL');
    set('last_ok_at', at);
  } else if (item.error && kind !== 'login_suspended') {
    set('last_error', item.error.message);
    set('last_error_kind', item.error.kind);
  }
  // Lockout protection: rejected credentials pause logins until the administrator replaces them; a
  // router lock-out pauses them until its wait has passed.
  if (kind === 'bad_credentials' || kind === 'no_credentials') {
    sets.push(`login_paused_reason = 'bad_credentials'`, 'login_paused_until = NULL');
  } else if (kind === 'locked_out') {
    const seconds = item.error?.retry_after_seconds || DEFAULT_LOCKOUT_MINUTES * 60;
    sets.push(`login_paused_reason = 'locked_out'`);
    set('login_paused_until', new Date(at.getTime() + seconds * 1000));
  }
  await db.query(`UPDATE site_routers SET ${sets.join(', ')} WHERE id = $1`, vals);
  if (!next || next === r.status) return;

  const base = { siteId: c.siteId, deviceId: r.device_id, collectorId: c.id, source: 'collector' as const, occurredAt: at };
  const details = { router_id: r.id, router: r.name, address: r.address, action: item.action, error: item.error ?? null };
  // Open/close semantics, like switch_unreadable / switch_readable: one event per change of state.
  if (LOGIN_STATES.includes(next) && !LOGIN_STATES.includes(r.status)) {
    await emitEvent(db, c.organizationId, {
      ...base,
      type: 'router_login_failed',
      severity: 'warning',
      title: next === 'locked_out' ? `Router ${r.name} locked its administrator account` : `Router ${r.name} rejected Nigafiy’s login`,
      details: { ...details, note: 'Nigafiy stopped logging in to this router so it cannot lock you out. Update the credentials to resume.' },
    });
  } else if (next === 'unreachable' && r.status === 'ok') {
    await emitEvent(db, c.organizationId, {
      ...base,
      type: 'router_unreachable',
      severity: 'warning',
      title: `Router ${r.name} cannot be reached`,
      details: { ...details, note: 'Client list and block state are as of the last successful read.' },
    });
  } else if (next === 'ok' && r.status !== 'never') {
    await emitEvent(db, c.organizationId, {
      ...base,
      type: 'router_reachable',
      severity: 'info',
      title: `Router ${r.name} answers again`,
      details: { ...details, recovered_from: r.status },
    });
  }
}

/**
 * Stores the router's settings. Each part the result carries replaces the stored part; a part it
 * does not carry (not offered, not read this time, or not re-read after a change) keeps its last
 * known value. A result older than what is stored is ignored.
 */
async function applySettings(db: Db, r: Target, settings: RouterSettings, at: Date): Promise<void> {
  const s: RouterSettings = {
    ...settings,
    ...(settings.wifi ? { wifi: settings.wifi.map((w) => (w.client_macs ? { ...w, client_macs: w.client_macs.map(normalizeMac) } : w)) } : {}),
    ...(settings.reservations ? { reservations: settings.reservations.map((x) => ({ ...x, mac: normalizeMac(x.mac) })) } : {}),
  };
  await db.query(
    `UPDATE site_routers SET settings = coalesce(settings, '{}'::jsonb) || $2::jsonb, settings_at = $3
      WHERE id = $1 AND (settings_at IS NULL OR settings_at <= $3)`,
    [r.id, JSON.stringify(s), at],
  );
}

async function applyRefresh(db: Db, c: CollectorContext, r: Target, item: RouterResultItem, at: Date): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [r.id];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (item.identity) set('identity', JSON.stringify(item.identity));
  if (item.capabilities) set('capabilities', JSON.stringify(item.capabilities));
  if (item.blocked) set('blocked_entries', JSON.stringify(item.blocked));
  if (item.clients) set('clients_refreshed_at', at);
  sets.push(`device_id = coalesce(device_id, (SELECT d.id FROM devices d WHERE d.site_id = site_routers.site_id AND d.current_ip = site_routers.address ORDER BY d.last_seen_at DESC LIMIT 1))`);
  await db.query(`UPDATE site_routers SET ${sets.join(', ')} WHERE id = $1`, vals);

  if (item.clients) {
    const cl = item.clients.map((x) => ({ ...x, mac: x.mac.toLowerCase().replaceAll('-', ':') }));
    if (cl.length) {
      await db.query(
        `INSERT INTO router_clients (router_id, mac, organization_id, site_id, device_id, ip, hostname, connection, interface, signal_dbm, active,
                                     lease_source, lease_remaining_seconds, blocked, raw, first_seen_at, last_seen_at)
         SELECT $1, x.mac::macaddr, $2, $3, (SELECT d.id FROM devices d WHERE d.site_id = $3 AND d.primary_mac = x.mac::macaddr ORDER BY d.last_seen_at DESC LIMIT 1),
                x.ip::inet, x.hostname, x.connection, x.interface, x.signal_dbm, x.active, x.lease_source, x.lease_remaining_seconds, x.blocked, coalesce(x.raw, '{}'), $4, $4
           FROM jsonb_to_recordset($5::jsonb) AS x(mac text, ip text, hostname text, connection text, interface text, signal_dbm int, active boolean,
                                                    lease_source text, lease_remaining_seconds bigint, blocked boolean, raw jsonb)
         ON CONFLICT (router_id, mac) DO UPDATE SET
           device_id = EXCLUDED.device_id, ip = EXCLUDED.ip, hostname = EXCLUDED.hostname, connection = EXCLUDED.connection, interface = EXCLUDED.interface,
           signal_dbm = EXCLUDED.signal_dbm, active = EXCLUDED.active, lease_source = EXCLUDED.lease_source,
           lease_remaining_seconds = EXCLUDED.lease_remaining_seconds, blocked = EXCLUDED.blocked, raw = EXCLUDED.raw, last_seen_at = EXCLUDED.last_seen_at`,
        [r.id, c.organizationId, c.siteId, at, JSON.stringify(cl)],
      );
    }
    await db.query(`DELETE FROM router_clients WHERE router_id = $1 AND last_seen_at < $2`, [r.id, at]);
  }

  if (item.blocked) {
    // Blocks lifted on the router itself (not through Nigafiy) close their ledger entry.
    const still = item.blocked.map((b) => b.mac.toLowerCase());
    const lifted = (
      await db.query<{ id: string; mac: string; device_id: string | null; pre_existing: boolean }>(
        `UPDATE router_blocks SET released_at = $3, released_via = 'router'
          WHERE router_id = $1 AND released_at IS NULL AND NOT (mac = ANY($2::macaddr[]))
          RETURNING id, mac::text AS mac, device_id, pre_existing`,
        [r.id, still, at],
      )
    ).rows;
    for (const l of lifted.filter((x) => !x.pre_existing)) {
      await emitEvent(db, c.organizationId, {
        siteId: c.siteId,
        deviceId: l.device_id,
        collectorId: c.id,
        type: 'device_unblocked',
        severity: 'info',
        title: `A block applied by Nigafiy is no longer in effect on ${r.name}`,
        details: { router_id: r.id, router: r.name, mac: l.mac, released_via: 'router', note: 'Lifted on the router itself, not through Nigafiy.' },
        source: 'collector',
        occurredAt: at,
      });
    }
  }
}

async function applyBlockChange(
  db: Db,
  c: CollectorContext,
  r: Target,
  item: RouterResultItem,
  request: { id: string; action: string; mac: string | null; device_id: string | null; created_by: string | null; created_by_email: string | null },
  at: Date,
): Promise<void> {
  const ch = item.change!;
  const mac = (item.mac ?? request.mac)!;
  const label = (
    await db.query<{ label: string }>(`SELECT coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS label FROM devices WHERE id = $1`, [request.device_id])
  ).rows[0]?.label ?? mac;
  await db.query(`UPDATE router_clients SET blocked = $3 WHERE router_id = $1 AND mac = $2::macaddr`, [r.id, mac, item.action === 'block']);
  if (item.action === 'block') {
    // already_in_effect: the device was blocked before Nigafiy acted (the administrator's own
    // block). It is recorded as pre-existing and never claimed: the product will not lift it.
    const inserted = await db.query(
      `INSERT INTO router_blocks (organization_id, site_id, router_id, mac, device_id, request_id, mechanism, pre_existing, applied_by, applied_by_email, applied_at, undo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [
        c.organizationId,
        c.siteId,
        r.id,
        mac,
        request.device_id,
        request.id,
        ch.mechanism,
        ch.already_in_effect,
        ch.already_in_effect ? null : request.created_by,
        ch.already_in_effect ? null : request.created_by_email,
        at,
        ch.undo || null,
      ],
    );
    if (inserted.rowCount && !ch.already_in_effect) {
      await emitEvent(db, c.organizationId, {
        siteId: c.siteId,
        deviceId: request.device_id,
        collectorId: c.id,
        type: 'device_blocked',
        severity: 'info',
        title: `${label} was blocked on ${r.name}`,
        details: { router_id: r.id, router: r.name, mac, by: request.created_by_email, mechanism: ch.mechanism, detail: ch.detail, undo: ch.undo, request_id: request.id },
        source: 'collector',
        occurredAt: at,
      });
    }
    return;
  }
  const released = await db.query(
    `UPDATE router_blocks SET released_at = $3, released_by = $4, released_by_email = $5, released_via = 'product'
      WHERE router_id = $1 AND mac = $2::macaddr AND released_at IS NULL AND NOT pre_existing`,
    [r.id, mac, at, request.created_by, request.created_by_email],
  );
  if (released.rowCount) {
    await emitEvent(db, c.organizationId, {
      siteId: c.siteId,
      deviceId: request.device_id,
      collectorId: c.id,
      type: 'device_unblocked',
      severity: 'info',
      title: `${label} was unblocked on ${r.name}`,
      details: { router_id: r.id, router: r.name, mac, by: request.created_by_email, released_via: 'product', detail: ch.detail, request_id: request.id },
      source: 'collector',
      occurredAt: at,
    });
  }
}
