import type { Request } from 'express';
import type { PortHistoryPoint, SwitchDetail, SwitchPort, SwitchSummary } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { seal } from '../credentials.ts';
import { portRole } from '../locate.ts';
import { MAX_TARGETS_PER_SITE, type PortHistoryRange, type SwitchCreate, type SwitchPatch } from '../schema.ts';

// Switches read over SNMP (Port Detective): management and the per-port picture.
// `req` is passed only for the audit trail.

const SUMMARY = `
  SELECT t.id, t.site_id, t.device_id, coalesce(t.name, t.sys_name, host(t.host)) AS name, host(t.host) AS host, t.port, t.version, t.enabled,
         t.poll_interval_seconds, t.last_polled_at, t.last_ok_at, t.last_status, t.last_error, t.sys_name, t.sys_descr, t.truncated,
         EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = t.site_id AND s.enabled AND t.host <<= s.cidr) AS in_scope,
         (SELECT count(*)::int FROM switch_ports p WHERE p.target_id = t.id) AS port_count,
         (SELECT count(*)::int FROM switch_ports p WHERE p.target_id = t.id AND p.oper_up) AS ports_up,
         (SELECT count(DISTINCT f.mac)::int FROM switch_fdb f WHERE f.target_id = t.id) AS address_count
    FROM snmp_targets t`;

async function queuePoll(db: Db, organizationId: string, siteId: string, userId: string): Promise<boolean> {
  const collector = (
    await db.query<{ id: string }>(
      `SELECT id FROM collectors WHERE site_id = $1 AND status = 'active' AND last_heartbeat_at > now() - interval '3 minutes' ORDER BY last_heartbeat_at DESC LIMIT 1`,
      [siteId],
    )
  ).rows[0];
  if (!collector) return false;
  const pending = await db.query(`SELECT 1 FROM collector_commands WHERE collector_id = $1 AND kind = 'poll_snmp' AND status <> 'completed'`, [collector.id]);
  if (!pending.rowCount) {
    await db.query(`INSERT INTO collector_commands (organization_id, collector_id, kind, created_by) VALUES ($1,$2,'poll_snmp',$3)`, [organizationId, collector.id, userId]);
  }
  return true;
}

export function listSwitches(organizationId: string, siteId: string | undefined): Promise<SwitchSummary[]> {
  return withTenant(organizationId, async (db) =>
    (await db.query<SwitchSummary>(`${SUMMARY} WHERE ($1::uuid IS NULL OR t.site_id = $1) ORDER BY t.host`, [siteId ?? null])).rows,
  );
}

export function addSwitch(req: Request, ctx: AuthContext, body: SwitchCreate): Promise<{ id: string; poll_queued: boolean }> {
  return withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount) throw notFound('Site');
    // Same boundary as discovery: only addresses inside a range the organization authorized.
    const inScope = await db.query(`SELECT 1 FROM network_scopes WHERE site_id = $1 AND enabled AND $2::inet <<= cidr`, [body.site_id, body.host]);
    if (!inScope.rowCount) throw new AppError(422, 'not_in_scope', 'This address is not inside an authorized network range of the site');
    const count = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM snmp_targets WHERE site_id = $1`, [body.site_id])).rows[0]!.n;
    if (count >= MAX_TARGETS_PER_SITE) throw new AppError(409, 'limit_reached', `A site can have at most ${MAX_TARGETS_PER_SITE} switches`);
    if ((await db.query(`SELECT 1 FROM snmp_targets WHERE site_id = $1 AND host = $2::inet AND port = $3`, [body.site_id, body.host, body.port])).rowCount) {
      throw new AppError(409, 'already_added', 'This switch is already added');
    }
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO snmp_targets (organization_id, site_id, device_id, name, host, port, version, secret_enc, created_by)
         VALUES ($1,$2,(SELECT id FROM devices WHERE site_id = $2 AND current_ip = $4::inet ORDER BY last_seen_at DESC LIMIT 1),$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.organizationId, body.site_id, body.name ?? null, body.host, body.port, body.credentials.version, seal(body.credentials), ctx.userId],
      )
    ).rows[0]!;
    // The audit trail records that credentials were set, never what they are.
    await audit(db, req, 'switch.add', { type: 'snmp_target', id: row.id }, { host: body.host, port: body.port, version: body.credentials.version });
    const queued = await queuePoll(db, ctx.organizationId, body.site_id, ctx.userId);
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return { id: row.id, poll_queued: queued };
  });
}

export async function updateSwitch(req: Request, ctx: AuthContext, id: string, body: SwitchPatch): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (body.name !== undefined) set('name', body.name);
    if (body.host !== undefined) {
      const cur = (await db.query<{ site_id: string; port: number }>(`SELECT site_id, port FROM snmp_targets WHERE id = $1`, [id])).rows[0];
      if (!cur) throw notFound('Switch');
      // Same rules as adding: inside an authorized range of the site, and not a duplicate.
      const inScope = await db.query(`SELECT 1 FROM network_scopes WHERE site_id = $1 AND enabled AND $2::inet <<= cidr`, [cur.site_id, body.host]);
      if (!inScope.rowCount) throw new AppError(422, 'not_in_scope', 'This address is not inside an authorized network range of the site');
      const dup = await db.query(`SELECT 1 FROM snmp_targets WHERE site_id = $1 AND host = $2::inet AND port = $3 AND id <> $4`, [cur.site_id, body.host, cur.port, id]);
      if (dup.rowCount) throw new AppError(409, 'already_added', 'This switch is already added');
      set('host', body.host);
      vals.push(cur.site_id);
      sets.push(`device_id = (SELECT d.id FROM devices d WHERE d.site_id = $${vals.length} AND d.current_ip = $${vals.length - 1}::inet ORDER BY d.last_seen_at DESC LIMIT 1)`);
    }
    if (body.enabled !== undefined) set('enabled', body.enabled);
    if (body.poll_interval_seconds !== undefined) set('poll_interval_seconds', body.poll_interval_seconds);
    if (body.credentials) {
      set('version', body.credentials.version);
      set('secret_enc', seal(body.credentials));
    }
    if (!sets.length) return;
    const r = await db.query(`UPDATE snmp_targets SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (!r.rowCount) throw notFound('Switch');
    await audit(db, req, 'switch.update', { type: 'snmp_target', id }, { ...body, credentials: body.credentials ? { version: body.credentials.version, changed: true } : undefined });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

export async function removeSwitch(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query(`DELETE FROM snmp_targets WHERE id = $1`, [id]);
    if (!r.rowCount) throw notFound('Switch');
    await audit(db, req, 'switch.remove', { type: 'snmp_target', id }, {});
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

/** Asks an online collector of the switch's site to read it now. False when none is online. */
export function requestPoll(ctx: AuthContext, id: string): Promise<boolean> {
  return withTenant(ctx.organizationId, async (db) => {
    const t = (await db.query<{ site_id: string }>(`SELECT site_id FROM snmp_targets WHERE id = $1`, [id])).rows[0];
    if (!t) throw notFound('Switch');
    return queuePoll(db, ctx.organizationId, t.site_id, ctx.userId);
  });
}

export function getSwitchDetail(organizationId: string, id: string): Promise<SwitchDetail> {
  return withTenant(organizationId, async (db): Promise<SwitchDetail> => {
    const summary = (await db.query<SwitchSummary>(`${SUMMARY} WHERE t.id = $1`, [id])).rows[0];
    if (!summary) throw notFound('Switch');
    const ports = (
      await db.query<Omit<SwitchPort, 'role' | 'devices' | 'unknown_addresses'>>(
        `SELECT if_index, name, descr, alias, admin_up, oper_up, speed_mbps::int AS speed_mbps, in_errors::float8 AS in_errors, out_errors::float8 AS out_errors,
                in_discards::float8 AS in_discards, out_discards::float8 AS out_discards, errors_delta::float8 AS errors_delta, discards_delta::float8 AS discards_delta, delta_seconds, in_bps, out_bps, mac_count, neighbors,
                oper_changed_at, updated_at
           FROM switch_ports WHERE target_id = $1 ORDER BY if_index`,
        [id],
      )
    ).rows;
    // Addresses on each port, matched to known devices of the same site by MAC.
    const seen = (
      await db.query<{ if_index: number; mac: string; vlan: number; device_id: string | null; label: string | null; ip: string | null; status: string | null; device_type: string | null }>(
        `SELECT f.if_index, f.mac::text AS mac, f.vlan, d.id AS device_id, coalesce(d.display_name, d.hostname, host(d.current_ip)) AS label,
                host(d.current_ip) AS ip, d.status, d.device_type
           FROM switch_fdb f
           LEFT JOIN devices d ON d.site_id = $2 AND d.primary_mac = f.mac
          WHERE f.target_id = $1 ORDER BY f.if_index, d.current_ip NULLS LAST, f.mac`,
        [id, summary.site_id],
      )
    ).rows;
    const byPort = new Map<number, typeof seen>();
    for (const s of seen) byPort.set(s.if_index, [...(byPort.get(s.if_index) ?? []), s]);
    return {
      ...summary,
      ports: ports.map((p) => {
        const on = byPort.get(p.if_index) ?? [];
        const role = portRole(p);
        const known = on.filter((s) => s.device_id);
        return {
          ...p,
          role,
          // A trunk lists every address in the building; showing them all there would be noise.
          devices: (role === 'trunk' || role === 'uplink' ? known.slice(0, 8) : known).map((s) => ({
            id: s.device_id!,
            label: s.label ?? s.mac,
            ip: s.ip,
            mac: s.mac,
            vlan: s.vlan,
            status: s.status as 'online',
            device_type: s.device_type ?? 'unknown',
          })),
          unknown_addresses: on.filter((s) => !s.device_id).map((s) => s.mac).slice(0, 8),
        };
      }),
    };
  });
}

// Bucket sizes keep a chart at a few hundred points. Reads normally arrive every 5 minutes.
const HISTORY: Record<PortHistoryRange, { seconds: number; bucket: number }> = {
  '6h': { seconds: 21_600, bucket: 300 },
  '24h': { seconds: 86_400, bucket: 300 },
  '7d': { seconds: 604_800, bucket: 3600 },
  '30d': { seconds: 2_592_000, bucket: 14_400 },
};

/** Traffic and error history of one port. */
export async function getPortHistory(organizationId: string, id: string, ifIndex: number, range: PortHistoryRange) {
  const r = HISTORY[range]!;
  const to = new Date();
  const from = new Date(to.getTime() - r.seconds * 1000);
  const data = await withTenant(organizationId, async (db) => {
    const port = (await db.query<{ name: string; speed_mbps: number }>(`SELECT name, speed_mbps::int AS speed_mbps FROM switch_ports WHERE target_id = $1 AND if_index = $2`, [id, ifIndex])).rows[0];
    if (!port) throw notFound('Port');
    // avg() ignores NULL rates, so a bucket is NULL only when no read in it produced a rate. The
    // maximum is the highest read-to-read average in the bucket, not a true peak.
    const points = (
      await db.query<PortHistoryPoint>(
        `SELECT date_bin(make_interval(secs => $5), ts, timestamptz '2000-01-01') AS ts,
                avg(in_bps) AS in_bps, avg(out_bps) AS out_bps, max(in_bps) AS in_max_bps, max(out_bps) AS out_max_bps,
                coalesce(sum(errors), 0)::int AS errors, coalesce(sum(discards), 0)::int AS discards, bool_and(oper_up) AS up, count(*)::int AS samples
           FROM switch_port_samples WHERE target_id = $1 AND if_index = $2 AND ts >= $3 AND ts < $4
          GROUP BY 1 ORDER BY 1`,
        [id, ifIndex, from, to, r.bucket],
      )
    ).rows;
    return { ...port, points };
  });
  return { from, to, bucket_seconds: r.bucket, ...data };
}
