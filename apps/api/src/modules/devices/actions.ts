import type { DeviceTrust } from '@nigafiy/shared-types';
import { AppError, notFound } from '../../common/http.ts';
import type { Db } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';

// Device actions callable by other modules (playbooks) inside the caller's tenant transaction.
// They apply the same rules as the matching routes (POST /devices/:id/wake, PATCH /devices/:id
// { trust }); auditing is the caller's job, because the caller knows who acted (a person or the system).

export interface WakeQueued {
  collector_id: string;
  collector: string;
  command_id: string;
  broadcast: string;
  mac: string;
}

/**
 * Wake-on-LAN: queue `wake_device` for an online collector of the device's site, broadcast inside the
 * authorized scope that contains the device. Throws the same 409 refusals as the route.
 */
export async function queueWakeOnLan(db: Db, organizationId: string, deviceId: string, createdBy: string | null): Promise<WakeQueued> {
  const device = (
    await db.query<{ site_id: string; mac: string | null; ip: string | null }>(
      `SELECT site_id, primary_mac::text AS mac, host(current_ip) AS ip FROM devices WHERE id = $1`,
      [deviceId],
    )
  ).rows[0];
  if (!device) throw notFound('Device');
  if (!device.mac) throw new AppError(409, 'no_mac', 'Wake-on-LAN needs the device’s MAC address, which has not been observed');
  if (!device.ip) throw new AppError(409, 'no_address', 'The device’s network is unknown');
  // Wake-on-LAN is an IPv4 broadcast; IPv6 has no broadcast and no wake-up standard (docs/features/ipv6.md).
  if (device.ip.includes(':')) throw new AppError(409, 'wol_ipv4_only', 'Wake-on-LAN needs an IPv4 address: it is sent as an IPv4 broadcast, and this device was only seen over IPv6');
  const scope = (
    await db.query<{ broadcast: string }>(
      `SELECT host(broadcast(cidr)) AS broadcast FROM network_scopes WHERE site_id = $1 AND enabled AND family(cidr) = 4 AND $2::inet <<= cidr ORDER BY masklen(cidr) DESC LIMIT 1`,
      [device.site_id, device.ip],
    )
  ).rows[0];
  if (!scope) throw new AppError(409, 'not_in_scope', 'The device is not inside an authorized network range');
  const collector = (
    await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM collectors WHERE site_id = $1 AND status = 'active' AND last_heartbeat_at > now() - interval '2 minutes'
        ORDER BY last_heartbeat_at DESC LIMIT 1`,
      [device.site_id],
    )
  ).rows[0];
  if (!collector) throw new AppError(409, 'no_collector', 'No collector of this site is online to send the wake packet');
  const command = await db.query<{ id: string }>(
    `INSERT INTO collector_commands (organization_id, collector_id, kind, payload, created_by) VALUES ($1,$2,'wake_device',$3,$4) RETURNING id`,
    [organizationId, collector.id, JSON.stringify({ mac: device.mac, broadcast: scope.broadcast }), createdBy],
  );
  return { collector_id: collector.id, collector: collector.name, command_id: command.rows[0]!.id, broadcast: scope.broadcast, mac: device.mac };
}

/** Change a device's approval state (known / unreviewed / unwanted). Returns the previous state. */
export async function setDeviceTrust(db: Db, organizationId: string, deviceId: string, trust: DeviceTrust): Promise<{ previous: DeviceTrust; changed: boolean }> {
  const row = (await db.query<{ trust: DeviceTrust }>(`SELECT trust FROM devices WHERE id = $1 FOR UPDATE`, [deviceId])).rows[0];
  if (!row) throw notFound('Device');
  if (row.trust === trust) return { previous: row.trust, changed: false };
  await db.query(`UPDATE devices SET trust = $2, trust_reason = NULL, trust_changed_at = now() WHERE id = $1`, [deviceId, trust]);
  await notifyRealtime(db, organizationId, 'devices');
  return { previous: row.trust, changed: true };
}
