import type { Db } from '../../infrastructure/db.ts';

// What the devices module can do to one device, for the consolidated GET /devices/:id/controls
// (assembled by modules/routers). Each function describes one section; none changes anything.

export interface ControlTarget {
  id: string;
  site_id: string;
  ip: string | null;
  mac: string | null;
}

/** Approval state (known / unwanted / unreviewed) — PATCH /devices/:id { trust }. */
export async function trustControl(db: Db, d: ControlTarget) {
  const row = (await db.query<{ trust: string; trust_changed_at: Date | null }>(`SELECT trust, trust_changed_at FROM devices WHERE id = $1`, [d.id])).rows[0]!;
  return { trust: row.trust, trust_changed_at: row.trust_changed_at, change: { possible: true, min_role: 'technician', method: 'PATCH', href: `/api/v1/devices/${d.id}`, values: ['unreviewed', 'known', 'unwanted'] } };
}

/** Alert mute — PATCH /devices/:id { alerts_muted }. */
export async function alertsControl(db: Db, d: ControlTarget) {
  const row = (await db.query<{ alerts_muted: boolean }>(`SELECT alerts_muted FROM devices WHERE id = $1`, [d.id])).rows[0]!;
  return { muted: row.alerts_muted, toggle: { possible: true, min_role: 'technician', method: 'PATCH', href: `/api/v1/devices/${d.id}`, field: 'alerts_muted' } };
}

/** The device's own monitoring check — POST /devices/:id/monitor. */
export async function monitoringControl(db: Db, d: ControlTarget) {
  const check = (
    await db.query<{ id: string; name: string; state: string; enabled: boolean; interval_seconds: number; last_latency_ms: number | null }>(
      `SELECT id, name, state, enabled, interval_seconds, last_latency_ms FROM monitoring_checks WHERE device_id = $1 ORDER BY created_at LIMIT 1`,
      [d.id],
    )
  ).rows[0];
  return {
    check: check ?? null,
    create: check
      ? { possible: false, reason: 'already_monitored' }
      : d.ip
        ? { possible: true, min_role: 'admin', method: 'POST', href: `/api/v1/devices/${d.id}/monitor` }
        : { possible: false, reason: 'no_address' },
  };
}

/** Wake-on-LAN — POST /devices/:id/wake. Same preconditions as the route itself. */
export async function wakeControl(db: Db, d: ControlTarget) {
  const no = (reason: string) => ({ possible: false, reason });
  if (!d.mac) return no('no_mac');
  if (!d.ip) return no('no_address');
  const scope = await db.query(`SELECT 1 FROM network_scopes WHERE site_id = $1 AND enabled AND $2::inet <<= cidr`, [d.site_id, d.ip]);
  if (!scope.rowCount) return no('not_in_scope');
  const collector = await db.query(
    `SELECT 1 FROM collectors WHERE site_id = $1 AND status = 'active' AND last_heartbeat_at > now() - interval '2 minutes'`,
    [d.site_id],
  );
  if (!collector.rowCount) return no('no_collector');
  return {
    possible: true,
    min_role: 'technician',
    method: 'POST',
    href: `/api/v1/devices/${d.id}/wake`,
    note: 'Works only if Wake-on-LAN is enabled on the device itself.',
  };
}
