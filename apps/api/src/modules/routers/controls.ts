import type { Request } from 'express';
import { notFound } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { deviceAccessControl } from '../access/index.ts';
import { alertsControl, monitoringControl, trustControl, wakeControl } from '../devices/index.ts';
import { deviceEndpointControl } from '../endpoints/index.ts';
import { devicePortLocation } from '../ports/index.ts';
import { capability, protectedDevice, requesterAddress } from './control.ts';
import { ROUTER_SELECT, type RouterRow, delivery, loginPause } from './service.ts';

// GET /devices/:id/controls — ONE description of everything that can be done to a device, and why
// or why not. Each section comes from the owning module's public index.ts and is computed inside its
// own savepoint: a section that fails is returned as { available: false, error } and the others
// are still answered.

type Section = ({ available: true } & Record<string, unknown>) | { available: false; error: { code: string; message: string } };

async function section(db: Db, name: string, fn: () => Promise<Record<string, unknown>>): Promise<Section> {
  await db.query('SAVEPOINT controls_section');
  try {
    const value = await fn();
    await db.query('RELEASE SAVEPOINT controls_section');
    return { available: true, ...value };
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT controls_section');
    logger.warn({ err, section: name }, 'device controls section failed');
    return { available: false, error: { code: 'section_failed', message: `The ${name.replaceAll('_', ' ')} information could not be read right now` } };
  }
}

async function routerSection(db: Db, req: Request, d: { id: string; site_id: string; label: string; ip: string | null; mac: string | null }) {
  const routers = (await db.query<RouterRow>(`${ROUTER_SELECT} WHERE r.site_id = $1 ORDER BY r.name`, [d.site_id])).rows;
  const guard = await protectedDevice(db, d, requesterAddress(req));
  const items = [];
  for (const r of routers) {
    const client = d.mac
      ? (
          await db.query(
            `SELECT host(ip) AS ip, hostname, connection, interface, signal_dbm, active, blocked, lease_source, lease_remaining_seconds, last_seen_at
               FROM router_clients WHERE router_id = $1 AND mac = $2::macaddr`,
            [r.id, d.mac],
          )
        ).rows[0]
      : undefined;
    const ledger = d.mac
      ? (
          await db.query<{ pre_existing: boolean; applied_by_email: string | null; applied_at: Date; mechanism: string | null; undo: string | null }>(
            `SELECT pre_existing, applied_by_email, applied_at, mechanism, undo FROM router_blocks WHERE router_id = $1 AND mac = $2::macaddr AND released_at IS NULL`,
            [r.id, d.mac],
          )
        ).rows[0]
      : undefined;
    const entries = (await db.query<{ blocked_entries: { mac: string; owner: string; mechanism: string; partial?: boolean; detail?: string }[] | null }>(
      `SELECT blocked_entries FROM site_routers WHERE id = $1`,
      [r.id],
    )).rows[0]!.blocked_entries;
    const onRouter = d.mac ? (entries ?? []).filter((e) => e.mac === d.mac) : [];
    const blockedState = ledger || onRouter.length || client?.blocked ? 'blocked' : entries || client ? 'not_blocked' : 'unknown';
    const by = ledger ? (ledger.pre_existing ? 'administrator' : 'lan-detective') : onRouter[0] ? (onRouter[0].owner === 'lan-detective' ? 'lan-detective' : onRouter[0].owner) : null;

    const deliv = delivery(r);
    const pause = loginPause(r);
    const notReady = deliv !== 'active' ? { possible: false, reason: `router_${deliv}` } : null;
    const capCheck = (name: string) => {
      if (!r.capabilities) return { possible: false, reason: 'capabilities_unknown' };
      const c = capability(r, name);
      return c?.supported ? null : { possible: false, reason: 'unsupported_on_router', note: c?.note ?? 'not reported by the driver' };
    };
    const blockAction =
      capCheck('block') ??
      notReady ??
      (!d.mac
        ? { possible: false, reason: 'no_mac' }
        : guard
          ? { possible: false, reason: guard.code, note: guard.message }
          : blockedState === 'blocked'
            ? { possible: false, reason: 'already_blocked' }
            : { possible: true, min_role: 'admin', method: 'POST', href: `/api/v1/routers/${r.id}/block`, body: { device_ids: [d.id] } });
    const unblockAction =
      capCheck('block') ??
      notReady ??
      (ledger && !ledger.pre_existing
        ? { possible: true, min_role: 'admin', method: 'POST', href: `/api/v1/routers/${r.id}/unblock`, body: { device_ids: [d.id] } }
        : { possible: false, reason: ledger?.pre_existing || (onRouter.length && !ledger) ? 'blocked_by_administrator' : 'not_blocked_by_product' });
    const passThrough = (name: string, path: string) =>
      capCheck(name) ?? notReady ?? (!d.mac ? { possible: false, reason: 'no_mac' } : { possible: true, min_role: 'admin', method: 'POST', href: `/api/v1/routers/${r.id}/${path}` });

    items.push({
      router_id: r.id,
      name: r.name,
      address: r.address,
      status: r.status,
      delivery: deliv,
      login_paused: pause.paused,
      login_paused_reason: pause.reason,
      // The device is matched to the router's client entry by MAC address: an inferred link.
      sees_device: client ? { ...client, link: 'inferred_by_mac' } : null,
      block_state: {
        state: blockedState,
        by,
        applied_by_email: ledger && !ledger.pre_existing ? ledger.applied_by_email : null,
        applied_at: ledger?.applied_at ?? null,
        mechanism: ledger?.mechanism ?? onRouter[0]?.mechanism ?? null,
        undo: ledger?.undo ?? null,
        router_entries: onRouter,
      },
      capabilities: r.capabilities,
      actions: { block: blockAction, unblock: unblockAction, rate_limit: passThrough('rate_limit', 'rate-limit'), schedule: passThrough('schedule', 'schedule') },
    });
  }
  return {
    routers: items,
    protected: guard,
    setup: routers.length ? null : { reason: 'no_router', href: '/routers', note: 'Add the site’s router to block devices on the network itself.' },
  };
}

export function deviceControls(req: Request, organizationId: string, deviceId: string) {
  return withTenant(organizationId, async (db) => {
    const d = (
      await db.query<{ id: string; site_id: string; label: string; ip: string | null; mac: string | null; mac_randomized: boolean; device_type: string | null; status: string }>(
        `SELECT id, site_id, coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS label, host(current_ip) AS ip,
                primary_mac::text AS mac, mac_randomized, device_type, status
           FROM devices WHERE id = $1`,
        [deviceId],
      )
    ).rows[0];
    if (!d) throw notFound('Device');
    const now = new Date();
    const target = { id: d.id, site_id: d.site_id, ip: d.ip, mac: d.mac };
    return {
      device: d,
      generated_at: now.toISOString(),
      sections: {
        trust: await section(db, 'trust', () => trustControl(db, target)),
        alerts: await section(db, 'alerts', () => alertsControl(db, target)),
        monitoring: await section(db, 'monitoring', () => monitoringControl(db, target)),
        wake_on_lan: await section(db, 'wake_on_lan', () => wakeControl(db, target)),
        dns_filter: await section(db, 'dns_filter', () => deviceAccessControl(db, target, now)),
        switch_port: await section(db, 'switch_port', () => devicePortLocation(db, d.id)),
        endpoint_agent: await section(db, 'endpoint_agent', () => deviceEndpointControl(db, { id: d.id, device_type: d.device_type })),
        router: await section(db, 'router', () => routerSection(db, req, d)),
      },
    };
  });
}
