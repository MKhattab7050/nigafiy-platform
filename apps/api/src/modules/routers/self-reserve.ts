import { networkInterfaces } from 'node:os';
import { auditSystem } from '../../common/audit.ts';
import type { AuthContext } from '../../common/http.ts';
import { normalizeMac } from '../../common/net.ts';
import { type Db, systemPool } from '../../infrastructure/db.ts';
import { automationEnabled } from '../automation/index.ts';
import { capability } from './control.ts';
import { delivery, loadRouter, queueRequest } from './service.ts';
import { lanAddressProblem, lanSubnet, loadSettings } from './settings.ts';

// The computer running Nigafiy keeps the same address at home (owner's request 2026-11-28): after a
// router is read, each of this computer's network adapters on the router's LAN gets its current
// address reserved there (automation router.reserve_own_address). Once per adapter and router: what
// was done is kept in site_routers.self_reservations, so a reservation removed by hand stays removed.

export interface OwnAdapter {
  mac: string;
  ip: string;
}

export interface SelfReservation {
  ip: string;
  state: 'requested' | 'already' | 'conflict';
  code: 'ip_reserved' | 'ip_in_use' | null;
  request_id: string | null;
  at: string;
}

/** This computer's IPv4 adapters with a real MAC (no loopback, no Tailscale / carrier NAT, no link-local). */
function readOwnAdapters(): OwnAdapter[] {
  const out: OwnAdapter[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!a.mac || a.mac === '00:00:00:00:00:00') continue;
      if (/^169\.254\./.test(a.address)) continue;
      const [p0, p1] = a.address.split('.').map(Number);
      if (p0 === 100 && p1! >= 64 && p1! <= 127) continue;
      out.push({ mac: normalizeMac(a.mac), ip: a.address });
    }
  }
  return out;
}

const RETRY_MS = 24 * 3600_000;

/** Status of the reserve requests Nigafiy made (request id → pending / completed / failed / expired). */
export async function requestStatuses(db: Db, done: Record<string, SelfReservation>): Promise<Map<string, string>> {
  const ids = Object.values(done).map((e) => e.request_id).filter((x): x is string => !!x);
  if (!ids.length) return new Map();
  const rows = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM router_requests WHERE id = ANY($1::uuid[])`, [ids])).rows;
  return new Map(rows.map((x) => [x.id, x.status]));
}

// Under the test runner the machine's real adapters are left out: a test LAN could match them.
let adapterSource: () => OwnAdapter[] = process.env.VITEST ? () => [] : readOwnAdapters;
/** Tests: replace where this computer's adapters come from (null: none). */
export function setOwnAdapterSource(fn: (() => OwnAdapter[]) | null): void {
  adapterSource = fn ?? (() => []);
}

/**
 * Called after a successful router read. Never throws for a reason that only means "not now": the
 * read that triggered it must still be stored.
 */
export async function reserveOwnAddresses(db: Db, organizationId: string, routerId: string): Promise<void> {
  const r = await loadRouter(db, routerId);
  if (!capability(r, 'reservations')?.supported) return;
  if (delivery(r) !== 'active') return;
  const { settings } = await loadSettings(db, r.id);
  if (!settings?.reservations) return;
  const adapters = adapterSource();
  if (!adapters.length) return;
  const lan = await lanSubnet(db, r, settings);
  const mine = adapters.filter((a) => !lanAddressProblem(lan, a.ip));
  if (!mine.length) return;

  const row = (
    await db.query<{ self_reservations: Record<string, SelfReservation>; created_by: string | null }>(`SELECT self_reservations, created_by FROM site_routers WHERE id = $1`, [r.id])
  ).rows[0]!;
  const done = row.self_reservations ?? {};
  const statuses = await requestStatuses(db, done);
  // Once per adapter; only a request that failed or ran out of time is tried again, a day later.
  const retry = (e: SelfReservation) =>
    e.state === 'requested' && !!e.request_id && ['failed', 'expired'].includes(statuses.get(e.request_id) ?? '') && Date.now() - Date.parse(e.at) > RETRY_MS;
  const todo = mine.filter((a) => !done[a.mac] || retry(done[a.mac]!));
  if (!todo.length) return;
  if (!(await automationEnabled(db, organizationId, r.site_id, 'router.reserve_own_address'))) return;

  // The tenant role cannot read users: the administrator's address comes from the system connection.
  const email = row.created_by
    ? ((await systemPool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [row.created_by])).rows[0]?.email ?? null)
    : null;
  const ctx: AuthContext = {
    organizationId,
    // Made on behalf of the administrator who added the router (and gave its password).
    userId: row.created_by as string,
    userEmail: email ?? 'Nigafiy',
    sessionId: '',
    role: 'admin',
  };
  const at = new Date().toISOString();
  const record = async (mac: string, entry: SelfReservation) => {
    await db.query(`UPDATE site_routers SET self_reservations = self_reservations || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`, [
      r.id,
      mac,
      JSON.stringify(entry),
    ]);
  };

  for (const a of todo) {
    const existing = settings.reservations.find((x) => normalizeMac(x.mac) === a.mac);
    if (existing) {
      await record(a.mac, { ip: existing.ip, state: 'already', code: null, request_id: null, at });
      continue;
    }
    const taken = settings.reservations.find((x) => x.ip === a.ip);
    const inUse = taken
      ? null
      : (await db.query(`SELECT 1 FROM router_clients WHERE router_id = $1 AND host(ip) = $2 AND mac <> $3::macaddr LIMIT 1`, [r.id, a.ip, a.mac])).rowCount;
    if (taken || inUse) {
      await record(a.mac, { ip: a.ip, state: 'conflict', code: taken ? 'ip_reserved' : 'ip_in_use', request_id: null, at });
      continue;
    }
    const pending = await db.query(`SELECT 1 FROM router_requests WHERE router_id = $1 AND mac = $2::macaddr AND action IN ('reserve','unreserve') AND status = 'pending'`, [
      r.id,
      a.mac,
    ]);
    if (pending.rowCount) continue; // someone asked already; look again on the next read
    const device = (
      await db.query<{ id: string }>(`SELECT id FROM devices WHERE site_id = $1 AND primary_mac = $2::macaddr ORDER BY last_seen_at DESC LIMIT 1`, [r.site_id, a.mac])
    ).rows[0];
    let q: { request_id: string };
    try {
      q = await queueRequest(db, ctx, r, 'reserve', { mac: a.mac, deviceId: device?.id ?? null, params: { ip: a.ip } });
    } catch {
      return; // no collector online right now: the next read tries again
    }
    await record(a.mac, { ip: a.ip, state: 'requested', code: null, request_id: q.request_id, at });
    await auditSystem(db, organizationId, {
      action: 'router.reserve',
      automation: 'router.reserve_own_address',
      siteId: r.site_id,
      target: device ? { type: 'device', id: device.id } : { type: 'router', id: r.id },
      metadata: { router_id: r.id, router: r.name, mac: a.mac, ip: a.ip, request_id: q.request_id, own_computer: true },
    });
  }
}

/** What the router page says about this computer's reservations: from what was done and the router's latest list. */
export function selfReservationStatus(
  done: Record<string, SelfReservation> | null | undefined,
  reservations: { mac: string; ip: string }[] | null | undefined,
  statuses: Map<string, string>,
): { mac: string; ip: string; status: 'reserved' | 'pending' | 'conflict' | 'failed' | 'removed'; code: string | null }[] {
  return Object.entries(done ?? {}).map(([mac, e]) => {
    const now = reservations?.find((x) => normalizeMac(x.mac) === mac);
    if (now) return { mac, ip: now.ip, status: 'reserved' as const, code: null };
    if (e.state === 'conflict') return { mac, ip: e.ip, status: 'conflict' as const, code: e.code };
    const st = e.request_id ? statuses.get(e.request_id) : undefined;
    if (st === 'pending') return { mac, ip: e.ip, status: 'pending' as const, code: null };
    if (st === 'failed' || st === 'expired') return { mac, ip: e.ip, status: 'failed' as const, code: null };
    // It was on the router and is gone now: removed by hand, and left that way.
    return { mac, ip: e.ip, status: 'removed' as const, code: null };
  });
}
