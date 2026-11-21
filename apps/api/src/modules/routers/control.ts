import type { Request } from 'express';
import { audit } from '../../common/audit.ts';
import { AppError, type AuthContext } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { type CapabilityStatus, type RouterRow, assertControllable, expireStaleRequests, loadRouter, queueRequest } from './service.ts';

// Explicit administrator control of devices on a router: block, unblock, rate limit, schedule.
// Nothing here runs without an administrator's request; nothing is ever blocked automatically.

export interface DeviceRef {
  id: string;
  site_id: string;
  label: string;
  ip: string | null;
  mac: string | null;
}

export interface Refusal {
  code: string;
  message: string;
}

/** The address a request came from, as the API sees it (IPv4-mapped IPv6 unwrapped). */
export function requesterAddress(req: Request): string | null {
  const ip = req.ip ?? null;
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Devices that must never be blocked from the product: the collector host (it would cut LAN
 * Detective off), the router/gateway itself, and the machine the request comes from (it would cut
 * the operator off). Identification uses what LAN Detective observed; when nothing identifies a
 * device as one of these, it is not protected.
 */
export async function protectedDevice(db: Db, d: DeviceRef, requesterIp: string | null): Promise<Refusal | null> {
  const facts = (
    await db.query<{ local: boolean; collector_ip: boolean; router: boolean; gateway: boolean }>(
      `SELECT ('local_interface' = ANY(coalesce(d.discovery_sources, '{}'))) AS local,
              EXISTS (SELECT 1 FROM collectors c, jsonb_array_elements(coalesce(c.interfaces, '[]'::jsonb)) i, jsonb_array_elements_text(i->'addresses') a
                       WHERE c.site_id = d.site_id AND c.status = 'active' AND d.current_ip IS NOT NULL AND split_part(a, '/', 1) = host(d.current_ip)) AS collector_ip,
              EXISTS (SELECT 1 FROM site_routers r WHERE r.site_id = d.site_id AND (r.device_id = d.id OR r.address = d.current_ip)) AS router,
              EXISTS (SELECT 1 FROM collectors c WHERE c.site_id = d.site_id AND c.gateway_ip IS NOT NULL AND c.gateway_ip = d.current_ip) AS gateway
         FROM devices d WHERE d.id = $1`,
      [d.id],
    )
  ).rows[0];
  if (facts?.local || facts?.collector_ip) return { code: 'collector_host', message: 'This is the computer running the LAN Detective collector; blocking it would stop monitoring and control' };
  if (facts?.router || facts?.gateway) return { code: 'gateway', message: 'This is the router or the network gateway itself' };
  if (requesterIp && d.ip && requesterIp === d.ip) return { code: 'own_machine', message: 'This is the machine you are using right now; blocking it would cut you off' };
  return null;
}

export function capability(r: RouterRow, name: string): CapabilityStatus | null {
  return r.capabilities?.find((c) => c.capability === name) ?? null;
}

/** Throws unless the router reported the capability as supported. */
export function assertCapability(r: RouterRow, name: string): void {
  if (!r.capabilities) {
    throw new AppError(409, 'capabilities_unknown', 'The router has not been read yet; run "Test / refresh" first so LAN Detective knows what it supports');
  }
  const c = capability(r, name);
  if (!c?.supported) {
    throw new AppError(409, 'unsupported_on_router', c?.note ? `Not supported on this router: ${c.note}` : 'Not supported on this router', {
      capability: name,
      note: c?.note ?? 'not reported by the driver',
    });
  }
}

async function loadDevices(db: Db, ids: string[]): Promise<Map<string, DeviceRef>> {
  const rows = (
    await db.query<DeviceRef>(
      `SELECT id, site_id, coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS label, host(current_ip) AS ip, primary_mac::text AS mac
         FROM devices WHERE id = ANY($1)`,
      [ids],
    )
  ).rows;
  return new Map(rows.map((d) => [d.id, d]));
}

export interface DeviceResult {
  device_id: string;
  status: 'queued' | 'refused';
  code?: string;
  message?: string;
  request_id?: string;
}

/** Block or unblock devices (one or several) on one router. Per-device results; the batch never fails as a whole for one device. */
export function changeBlocks(req: Request, ctx: AuthContext, routerId: string, deviceIds: string[], action: 'block' | 'unblock') {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStaleRequests(db);
    const r = await loadRouter(db, routerId, true);
    assertControllable(r);
    assertCapability(r, 'block');
    const devices = await loadDevices(db, [...new Set(deviceIds)]);
    const requester = requesterAddress(req);
    const results: DeviceResult[] = [];
    for (const id of [...new Set(deviceIds)]) {
      const refuse = (code: string, message: string) => results.push({ device_id: id, status: 'refused', code, message });
      const d = devices.get(id);
      if (!d) {
        refuse('not_found', 'Device not found');
        continue;
      }
      if (d.site_id !== r.site_id) {
        refuse('other_site', 'The device belongs to another site than the router');
        continue;
      }
      if (!d.mac) {
        refuse('no_mac', 'The device’s MAC address has not been observed; a router blocks devices by MAC');
        continue;
      }
      const pending = await db.query(`SELECT 1 FROM router_requests WHERE router_id = $1 AND mac = $2::macaddr AND action IN ('block','unblock') AND status = 'pending'`, [r.id, d.mac]);
      if (pending.rowCount) {
        refuse('already_requested', 'A block or unblock of this device on this router is still waiting for the collector');
        continue;
      }
      const open = (
        await db.query<{ pre_existing: boolean; applied_by_email: string | null }>(
          `SELECT pre_existing, applied_by_email FROM router_blocks WHERE router_id = $1 AND mac = $2::macaddr AND released_at IS NULL`,
          [r.id, d.mac],
        )
      ).rows[0];
      if (action === 'block') {
        const guard = await protectedDevice(db, d, requester);
        if (guard) {
          refuse(guard.code, guard.message);
          continue;
        }
        if (open) {
          refuse('already_blocked', open.pre_existing ? 'The device is already blocked on the router by the administrator' : `Already blocked by ${open.applied_by_email ?? 'LAN Detective'}`);
          continue;
        }
      } else if (!open || open.pre_existing) {
        // Only blocks LAN Detective applied itself can be lifted from the product.
        refuse(
          'not_applied_by_product',
          open?.pre_existing
            ? 'This block was made on the router by an administrator; LAN Detective does not lift blocks it did not apply'
            : 'LAN Detective has no block of its own on this device on this router',
        );
        continue;
      }
      const q = await queueRequest(db, ctx, r, action, { mac: d.mac, deviceId: d.id });
      await audit(db, req, `router.${action}`, { type: 'device', id: d.id }, { router_id: r.id, router: r.name, mac: d.mac, request_id: q.request_id });
      results.push({ device_id: id, status: 'queued', request_id: q.request_id });
    }
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return { router_id: r.id, action, queued: results.filter((x) => x.status === 'queued').length, results };
  });
}

export async function oneDevice(db: Db, r: RouterRow, deviceId: string): Promise<DeviceRef & { mac: string }> {
  const d = (await loadDevices(db, [deviceId])).get(deviceId);
  if (!d || d.site_id !== r.site_id) throw new AppError(404, 'not_found', 'Device not found on this router’s site');
  if (!d.mac) throw new AppError(409, 'no_mac', 'The device’s MAC address has not been observed');
  return d as DeviceRef & { mac: string };
}

/** Rate limit pass-through: only for routers whose driver reports `rate_limit` as supported. */
export function setRateLimit(req: Request, ctx: AuthContext, routerId: string, deviceId: string, limit: { down_kbps: number; up_kbps: number } | null) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStaleRequests(db);
    const r = await loadRouter(db, routerId, true);
    assertCapability(r, 'rate_limit');
    assertControllable(r);
    const d = await oneDevice(db, r, deviceId);
    if (limit) {
      const guard = await protectedDevice(db, d, requesterAddress(req));
      if (guard) throw new AppError(409, guard.code, guard.message);
    }
    const q = await queueRequest(db, ctx, r, limit ? 'rate_limit' : 'clear_rate_limit', { mac: d.mac, deviceId: d.id, params: limit ? { limit } : {} });
    await audit(db, req, limit ? 'router.rate_limit' : 'router.rate_limit.clear', { type: 'device', id: d.id }, { router_id: r.id, mac: d.mac, limit, request_id: q.request_id });
    return q;
  });
}

/** Schedule pass-through: only for routers whose driver reports `schedule` as supported. */
export function setSchedule(
  req: Request,
  ctx: AuthContext,
  routerId: string,
  deviceId: string,
  windows: { days: number[]; start: string; end: string }[] | null,
) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStaleRequests(db);
    const r = await loadRouter(db, routerId, true);
    assertCapability(r, 'schedule');
    assertControllable(r);
    const d = await oneDevice(db, r, deviceId);
    if (windows) {
      const guard = await protectedDevice(db, d, requesterAddress(req));
      if (guard) throw new AppError(409, guard.code, guard.message);
    }
    const q = await queueRequest(db, ctx, r, windows ? 'schedule' : 'clear_schedule', { mac: d.mac, deviceId: d.id, params: windows ? { windows } : {} });
    await audit(db, req, windows ? 'router.schedule' : 'router.schedule.clear', { type: 'device', id: d.id }, { router_id: r.id, mac: d.mac, windows, request_id: q.request_id });
    return q;
  });
}
