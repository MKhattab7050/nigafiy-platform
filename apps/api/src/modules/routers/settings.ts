import type { Request } from 'express';
import ipaddr from 'ipaddr.js';
import { audit } from '../../common/audit.ts';
import type { RouterSettings } from '../../common/collector-protocol.ts';
import { AppError, type AuthContext } from '../../common/http.ts';
import { normalizeMac } from '../../common/net.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { assertCapability, oneDevice, protectedDevice, requesterAddress, siteDevice } from './control.ts';
import { MANAGEMENT_PORTS, MAX_PORTS_PER_RULE, type PortForwardBody } from './schema.ts';
import { type RouterAction, type RouterRow, assertControllable, expireStaleRequests, loadRouter, queueRequest } from './service.ts';

// Router controls beyond blocking (docs/features/router-controls.md): Wi-Fi on/off, DHCP
// reservations, port forwarding, rename on the router, reboot. Each is an explicit administrator
// request, checked here against the settings the router last reported and re-checked by the
// collector against the router itself. Nothing here is ever automatic.

export type PortForwardRule = NonNullable<RouterSettings['port_forwards']>[number];
export type WifiNetwork = NonNullable<RouterSettings['wifi']>[number];
export type Reservation = NonNullable<RouterSettings['reservations']>[number];

export interface StoredSettings {
  settings: RouterSettings | null;
  settings_at: Date | null;
}

export async function loadSettings(db: Db, routerId: string): Promise<StoredSettings> {
  const row = (await db.query<StoredSettings>(`SELECT settings, settings_at FROM site_routers WHERE id = $1`, [routerId])).rows[0];
  return { settings: row?.settings ?? null, settings_at: row?.settings_at ?? null };
}

export interface LanSubnet {
  cidr: string;
  /**
   * collector_interface: the prefix of the collector's own interface on the router's LAN;
   * assumed_24: nothing better is known, the /24 around the router's LAN address is assumed.
   */
  source: 'collector_interface' | 'assumed_24';
  network: string;
  broadcast: string;
  /** The router's own addresses on the LAN (its configured address and the LAN IP it reported). */
  router_ips: string[];
}

/**
 * The router's LAN subnet: the router's LAN IP (as it reported it, else the address it is managed
 * at) with the prefix of a collector interface on that network; when no collector interface is on
 * it, the /24 around that address.
 */
export async function lanSubnet(db: Db, r: RouterRow, settings: RouterSettings | null): Promise<LanSubnet> {
  const base = settings?.overview?.lan_ip ?? r.address;
  const baseAddr = ipaddr.IPv4.parse(base);
  const rows = (
    await db.query<{ a: string }>(
      `SELECT a FROM collectors c, jsonb_array_elements(coalesce(c.interfaces, '[]'::jsonb)) i, jsonb_array_elements_text(coalesce(i->'addresses', '[]'::jsonb)) a
        WHERE c.site_id = $1 AND c.status = 'active'`,
      [r.site_id],
    )
  ).rows;
  let best: number | null = null;
  for (const { a } of rows) {
    try {
      const [addr, prefix] = ipaddr.IPv4.parseCIDR(a);
      if (prefix < 8 || prefix > 30) continue;
      if (baseAddr.match(addr, prefix) && (best === null || prefix > best)) best = prefix;
    } catch {
      // not an IPv4 CIDR (IPv6, or an address without a prefix)
    }
  }
  const prefix = best ?? 24;
  const network = ipaddr.IPv4.networkAddressFromCIDR(`${base}/${prefix}`).toString();
  return {
    cidr: `${network}/${prefix}`,
    source: best === null ? 'assumed_24' : 'collector_interface',
    network,
    broadcast: ipaddr.IPv4.broadcastAddressFromCIDR(`${base}/${prefix}`).toString(),
    router_ips: [...new Set([r.address, base])],
  };
}

function inSubnet(lan: LanSubnet, ip: string): boolean {
  try {
    return ipaddr.IPv4.parse(ip).match(ipaddr.IPv4.parseCIDR(lan.cidr));
  } catch {
    return false;
  }
}

/** Why an address cannot be given to a device on this LAN, or null. */
export function lanAddressProblem(lan: LanSubnet, ip: string): { code: string; message: string } | null {
  if (!inSubnet(lan, ip)) return { code: 'outside_lan', message: `The address is not inside the router’s LAN (${lan.cidr})` };
  if (lan.router_ips.includes(ip)) return { code: 'router_address', message: 'This is the router’s own address' };
  if (ip === lan.network || ip === lan.broadcast) return { code: 'reserved_address', message: 'The network and broadcast addresses cannot be given to a device' };
  return null;
}

const protocolsOverlap = (a: string, b: string) => a === b || a === 'both' || b === 'both';
const rangesOverlap = (s1: number, e1: number, s2: number, e2: number) => s1 <= e2 && s2 <= e1;

function settingsUnknown(part: string): AppError {
  return new AppError(409, 'settings_unknown', `The router’s ${part.replaceAll('_', ' ')} have not been read yet; use “Read now” first`, { part });
}

async function assertNotPending(db: Db, r: RouterRow, actions: RouterAction[], where: { mac?: string; wifiId?: string } = {}): Promise<void> {
  const pending = await db.query(
    `SELECT 1 FROM router_requests
      WHERE router_id = $1 AND action = ANY($2) AND status = 'pending'
        AND ($3::macaddr IS NULL OR mac = $3::macaddr) AND ($4::text IS NULL OR params->>'wifi_id' = $4)`,
    [r.id, actions, where.mac ?? null, where.wifiId ?? null],
  );
  if (pending.rowCount) throw new AppError(409, 'already_requested', 'A request for this on this router is still waiting for the collector');
}

/** Common start of every control: the router (locked), its capability, deliverable, and its stored settings. */
async function prepare(db: Db, routerId: string, cap: string): Promise<{ r: RouterRow; settings: RouterSettings | null }> {
  await expireStaleRequests(db);
  const r = await loadRouter(db, routerId, true);
  assertCapability(r, cap);
  assertControllable(r);
  return { r, settings: (await loadSettings(db, r.id)).settings };
}

/** MACs of the machines whose Wi-Fi must not be switched off from the product: the collector host and the requester's machine. */
async function guardedMacs(db: Db, r: RouterRow, requesterIp: string | null): Promise<{ collector: Set<string>; requester: Set<string> }> {
  const collector = (
    await db.query<{ mac: string }>(
      `SELECT d.primary_mac::text AS mac FROM devices d
        WHERE d.site_id = $1 AND d.primary_mac IS NOT NULL
          AND ('local_interface' = ANY(coalesce(d.discovery_sources, '{}'))
               OR EXISTS (SELECT 1 FROM collectors c, jsonb_array_elements(coalesce(c.interfaces, '[]'::jsonb)) i, jsonb_array_elements_text(coalesce(i->'addresses', '[]'::jsonb)) a
                           WHERE c.site_id = d.site_id AND c.status = 'active' AND d.current_ip IS NOT NULL AND split_part(a, '/', 1) = host(d.current_ip)))`,
      [r.site_id],
    )
  ).rows.map((x) => x.mac);
  const requester = requesterIp
    ? (
        await db.query<{ mac: string }>(
          `SELECT primary_mac::text AS mac FROM devices WHERE site_id = $1 AND primary_mac IS NOT NULL AND host(current_ip) = $2
           UNION SELECT mac::text FROM router_clients WHERE router_id = $3 AND host(ip) = $2`,
          [r.site_id, requesterIp, r.id],
        )
      ).rows.map((x) => x.mac)
    : [];
  return { collector: new Set(collector), requester: new Set(requester) };
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────

/** GET /routers/:id/settings — the settings as last read, with device names resolved (any role). */
export function routerSettings(organizationId: string, routerId: string) {
  return withTenant(organizationId, async (db) => {
    const r = await loadRouter(db, routerId);
    const { settings, settings_at } = await loadSettings(db, r.id);
    const lan = await lanSubnet(db, r, settings);
    const known = (
      await db.query<{ device_id: string | null; mac: string | null; ip: string | null; label: string | null }>(
        `SELECT d.id AS device_id, d.primary_mac::text AS mac, host(d.current_ip) AS ip, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS label
           FROM devices d WHERE d.site_id = $1
         UNION ALL
         SELECT c.device_id, c.mac::text, host(c.ip), coalesce(c.hostname, host(c.ip)) FROM router_clients c WHERE c.router_id = $2`,
        [r.site_id, r.id],
      )
    ).rows;
    // Devices first (their names are the operator's), the router's client names as a fallback.
    const byMac = new Map<string, { device_id: string | null; label: string | null }>();
    const byIp = new Map<string, { device_id: string | null; label: string | null }>();
    for (const k of known) {
      if (k.mac && !byMac.has(k.mac)) byMac.set(k.mac, { device_id: k.device_id, label: k.label });
      if (k.ip && !byIp.has(k.ip)) byIp.set(k.ip, { device_id: k.device_id, label: k.label });
    }
    const pending = (
      await db.query(
        `SELECT id, action, mac::text AS mac, device_id, params, created_by_email, created_at FROM router_requests
          WHERE router_id = $1 AND status = 'pending' AND action IN ('rename','wifi','reserve','unreserve','add_port_forward','remove_port_forward','reboot')
          ORDER BY created_at`,
        [r.id],
      )
    ).rows;
    return {
      router_id: r.id,
      settings_at,
      lan: { cidr: lan.cidr, source: lan.source, router_ips: lan.router_ips },
      overview: settings?.overview ?? null,
      wifi: settings?.wifi?.map((w) => ({ ...w, client_count: w.client_macs?.length ?? null })) ?? null,
      reservations:
        settings?.reservations?.map((x) => {
          const who = byMac.get(normalizeMac(x.mac));
          return { ...x, device_id: who?.device_id ?? null, device_label: who?.label ?? null };
        }) ?? null,
      port_forwards:
        settings?.port_forwards?.map((x) => {
          const who = byIp.get(x.internal_ip);
          return { ...x, device_id: who?.device_id ?? null, device_label: who?.label ?? null };
        }) ?? null,
      pending,
    };
  });
}

// ── controls ──────────────────────────────────────────────────────────────────────────────────────

/** Set the name the router shows for a device (its client list entry). */
export function renameOnRouter(req: Request, ctx: AuthContext, routerId: string, deviceId: string, name: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const { r } = await prepare(db, routerId, 'rename');
    const d = await oneDevice(db, r, deviceId);
    if (!(await db.query(`SELECT 1 FROM router_clients WHERE router_id = $1 AND mac = $2::macaddr`, [r.id, d.mac])).rowCount) {
      throw new AppError(409, 'not_on_router', 'The router does not list this device as a client; it can only rename devices it knows');
    }
    await assertNotPending(db, r, ['rename'], { mac: d.mac });
    const q = await queueRequest(db, ctx, r, 'rename', { mac: d.mac, deviceId: d.id, params: { name } });
    await audit(db, req, 'router.rename', { type: 'device', id: d.id }, { router_id: r.id, router: r.name, mac: d.mac, name, request_id: q.request_id });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return q;
  });
}

/** Turn one Wi-Fi network on or off. */
export function setWifi(req: Request, ctx: AuthContext, routerId: string, body: { wifi_id: string; enabled: boolean; confirm?: boolean }) {
  return withTenant(ctx.organizationId, async (db) => {
    const { r, settings } = await prepare(db, routerId, 'wifi');
    if (!settings?.wifi) throw settingsUnknown('wifi');
    const net = settings.wifi.find((w) => w.id === body.wifi_id);
    if (!net) throw new AppError(404, 'not_found', 'The router does not list this Wi-Fi network (any more); read the router again');
    if (!body.enabled) {
      const macs = new Set((net.client_macs ?? []).map(normalizeMac));
      const guard = await guardedMacs(db, r, requesterAddress(req));
      if ([...guard.collector].some((m) => macs.has(m))) {
        throw new AppError(409, 'collector_host', 'The computer running the Nigafiy collector is connected to this network; turning it off would cut Nigafiy off from the router');
      }
      if ([...guard.requester].some((m) => macs.has(m))) {
        throw new AppError(409, 'own_machine', 'The machine you are using right now is connected to this network; turning it off would cut you off');
      }
      if (net.main && body.confirm !== true) {
        throw new AppError(409, 'confirm_required', 'Turning off a main Wi-Fi network disconnects every device on it; confirm to go ahead', {
          clients: net.client_macs?.length ?? null,
        });
      }
    } else if (net.guest && !net.main) {
      const mains = settings.wifi.filter((w) => w.main && w.band === net.band);
      if (mains.length && mains.every((w) => !w.enabled)) {
        throw new AppError(409, 'main_network_off', `The main ${net.band} network is off; turn it on before its guest network`);
      }
    }
    await assertNotPending(db, r, ['wifi'], { wifiId: net.id });
    const q = await queueRequest(db, ctx, r, 'wifi', { params: { wifi_id: net.id, enabled: body.enabled } });
    await audit(db, req, 'router.wifi', { type: 'router', id: r.id }, {
      router: r.name,
      wifi_id: net.id,
      ssid: net.ssid,
      band: net.band,
      main: net.main,
      guest: net.guest,
      enabled: body.enabled,
      confirmed: body.confirm === true,
      request_id: q.request_id,
    });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return q;
  });
}

/** Reserve an IPv4 address for a device (DHCP static lease). */
export function reserveAddress(req: Request, ctx: AuthContext, routerId: string, deviceId: string, ip: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const { r, settings } = await prepare(db, routerId, 'reservations');
    if (!settings?.reservations) throw settingsUnknown('reservations');
    const d = await oneDevice(db, r, deviceId);
    const lan = await lanSubnet(db, r, settings);
    const problem = lanAddressProblem(lan, ip);
    if (problem) throw new AppError(422, problem.code, problem.message, { lan: lan.cidr });
    const taken = settings.reservations.find((x) => x.ip === ip && normalizeMac(x.mac) !== d.mac);
    if (taken) throw new AppError(409, 'ip_reserved', 'This address is already reserved for another device on the router', { mac: normalizeMac(taken.mac) });
    const inUse = (
      await db.query<{ mac: string }>(`SELECT mac::text AS mac FROM router_clients WHERE router_id = $1 AND host(ip) = $2 AND mac <> $3::macaddr LIMIT 1`, [r.id, ip, d.mac])
    ).rows[0];
    if (inUse) throw new AppError(409, 'ip_in_use', 'Another device on the router currently has this address', { mac: inUse.mac });
    await assertNotPending(db, r, ['reserve', 'unreserve'], { mac: d.mac });
    const previous = settings.reservations.find((x) => normalizeMac(x.mac) === d.mac) ?? null;
    const q = await queueRequest(db, ctx, r, 'reserve', { mac: d.mac, deviceId: d.id, params: { ip } });
    await audit(db, req, 'router.reserve', { type: 'device', id: d.id }, { router_id: r.id, router: r.name, mac: d.mac, ip, previous_ip: previous?.ip ?? null, request_id: q.request_id });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return q;
  });
}

/** Remove a device's reservation (whoever made it: the router keeps no owner). */
export function removeReservation(req: Request, ctx: AuthContext, routerId: string, deviceId: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const { r, settings } = await prepare(db, routerId, 'reservations');
    if (!settings?.reservations) throw settingsUnknown('reservations');
    const d = await oneDevice(db, r, deviceId);
    return unreserve(db, req, ctx, r, settings.reservations, d.mac, d.id);
  });
}

/**
 * Remove a reservation by its MAC address, for entries the router lists whose MAC matches no device
 * record (a device never seen on the network, or seen without its MAC). When a device of the site
 * does have that MAC, the request is linked to it as usual.
 */
export function removeReservationByMac(req: Request, ctx: AuthContext, routerId: string, mac: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const { r, settings } = await prepare(db, routerId, 'reservations');
    if (!settings?.reservations) throw settingsUnknown('reservations');
    const device = (
      await db.query<{ id: string }>(`SELECT id FROM devices WHERE site_id = $1 AND primary_mac = $2::macaddr ORDER BY last_seen_at DESC LIMIT 1`, [r.site_id, mac])
    ).rows[0];
    return unreserve(db, req, ctx, r, settings.reservations, mac, device?.id ?? null);
  });
}

async function unreserve(db: Db, req: Request, ctx: AuthContext, r: RouterRow, reservations: Reservation[], mac: string, deviceId: string | null) {
  const current = reservations.find((x) => normalizeMac(x.mac) === mac);
  if (!current) throw new AppError(404, 'not_reserved', deviceId ? 'The router has no reservation for this device' : 'The router lists no reservation for this MAC address (any more); read the router again');
  await assertNotPending(db, r, ['reserve', 'unreserve'], { mac });
  const q = await queueRequest(db, ctx, r, 'unreserve', { mac, deviceId });
  await audit(db, req, 'router.unreserve', deviceId ? { type: 'device', id: deviceId } : { type: 'router', id: r.id }, {
    router_id: r.id,
    router: r.name,
    mac,
    ip: current.ip,
    device_id: deviceId,
    request_id: q.request_id,
  });
  await notifyRealtime(db, ctx.organizationId, 'devices');
  return q;
}

/** Validates a new rule against the request rules and the rules the router last reported. Exported for tests of the rules. */
export function portForwardProblem(
  rule: { protocol: 'tcp' | 'udp' | 'both'; external_start: number; external_end: number; internal_start: number; internal_end: number },
  existing: PortForwardRule[],
): { status: number; code: string; message: string } | null {
  const { protocol, external_start: es, external_end: ee, internal_start: is, internal_end: ie } = rule;
  if (ee < es || ie < is) return { status: 422, code: 'invalid_range', message: 'A port range must end at or after its start' };
  if (ee - es !== ie - is) return { status: 422, code: 'invalid_range', message: 'The external and internal port ranges must have the same length' };
  if (ie > 65535) return { status: 422, code: 'invalid_range', message: 'Ports go up to 65535' };
  if (ee - es + 1 > MAX_PORTS_PER_RULE) return { status: 422, code: 'too_many_ports', message: `A rule can forward at most ${MAX_PORTS_PER_RULE} ports` };
  const mgmt = MANAGEMENT_PORTS.find((p) => p >= es && p <= ee);
  if (mgmt !== undefined) {
    return { status: 422, code: 'management_port', message: `Port ${mgmt} is used to manage the router itself (web page, SSH, Telnet or TR-069) and is never forwarded` };
  }
  const clash = existing.find((x) => protocolsOverlap(x.protocol, protocol) && rangesOverlap(es, ee, x.external_start, x.external_end));
  if (clash) {
    return {
      status: 409,
      code: 'port_overlap',
      message: `The external ports overlap the router’s rule “${clash.description}” (${clash.protocol} ${clash.external_start}${clash.external_end !== clash.external_start ? `–${clash.external_end}` : ''})`,
    };
  }
  return null;
}

/** Forward external ports to a device (its current address). */
export function addPortForward(req: Request, ctx: AuthContext, routerId: string, body: PortForwardBody) {
  return withTenant(ctx.organizationId, async (db) => {
    const { r, settings } = await prepare(db, routerId, 'port_forward');
    if (!settings?.port_forwards) throw settingsUnknown('port_forwards');
    // Keyed by the device's LAN address, like the control offered on the device page: the MAC is not needed.
    const d = await siteDevice(db, r, body.device_id);
    if (!d.ip) throw new AppError(409, 'no_address', 'The device’s current IP address is not known');
    // Exposing the collector host or the router itself to the internet is never offered.
    const guard = await protectedDevice(db, d, null);
    if (guard) throw new AppError(409, guard.code, guard.code === 'gateway' ? 'Ports cannot be forwarded to the router itself' : 'Ports cannot be forwarded to the computer running the Nigafiy collector');
    const lan = await lanSubnet(db, r, settings);
    const problem = lanAddressProblem(lan, d.ip);
    if (problem) throw new AppError(422, problem.code, problem.message, { lan: lan.cidr });
    const external_end = body.external_end ?? body.external_start;
    const internal_start = body.internal_start ?? body.external_start;
    const internal_end = body.internal_end ?? internal_start + (external_end - body.external_start);
    const rule = { protocol: body.protocol, external_start: body.external_start, external_end, internal_start, internal_end };
    const bad = portForwardProblem(rule, settings.port_forwards);
    if (bad) throw new AppError(bad.status, bad.code, bad.message);
    // Overlaps are checked against the router's list as last read: one rule change at a time.
    await assertNotPending(db, r, ['add_port_forward', 'remove_port_forward']);
    const port_forward = { description: body.description, ...rule, internal_ip: d.ip };
    const q = await queueRequest(db, ctx, r, 'add_port_forward', { deviceId: d.id, params: { port_forward } });
    await audit(db, req, 'router.add_port_forward', { type: 'device', id: d.id }, { router_id: r.id, router: r.name, ...port_forward, request_id: q.request_id });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return q;
  });
}

/** Remove a port-forwarding rule (by the router's id; the collector re-checks it is still the same rule). */
export function removePortForward(req: Request, ctx: AuthContext, routerId: string, ruleId: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const { r, settings } = await prepare(db, routerId, 'port_forward');
    if (!settings?.port_forwards) throw settingsUnknown('port_forwards');
    const rule = settings.port_forwards.find((x) => x.id === ruleId);
    if (!rule) throw new AppError(404, 'not_found', 'The router does not list this rule (any more); read the router again');
    await assertNotPending(db, r, ['add_port_forward', 'remove_port_forward']);
    const device = (await db.query<{ id: string }>(`SELECT id FROM devices WHERE site_id = $1 AND host(current_ip) = $2 ORDER BY last_seen_at DESC LIMIT 1`, [r.site_id, rule.internal_ip]))
      .rows[0];
    const q = await queueRequest(db, ctx, r, 'remove_port_forward', { deviceId: device?.id ?? null, params: { port_forward: rule } });
    await audit(db, req, 'router.remove_port_forward', { type: 'router', id: r.id }, { router: r.name, ...rule, request_id: q.request_id });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return q;
  });
}

/** Restart the router. The body must say {"confirm": "reboot"} (checked by the route's schema). */
export function rebootRouter(req: Request, ctx: AuthContext, routerId: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const { r } = await prepare(db, routerId, 'reboot');
    await assertNotPending(db, r, ['reboot']);
    const q = await queueRequest(db, ctx, r, 'reboot');
    await audit(db, req, 'router.reboot', { type: 'router', id: r.id }, { router: r.name, address: r.address, request_id: q.request_id });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return q;
  });
}
