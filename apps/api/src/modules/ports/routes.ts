import { Router } from 'express';
import { z } from 'zod';
import type { PortHistoryPoint, PortLocation as PortLocationDto, SwitchDetail, SwitchPort, SwitchSummary } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { decryptSecret, encryptSecret } from '../../common/crypto.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../events/emit.ts';
import { type Sighting, locate, portRole } from './locate.ts';

export const portsRouter: Router = Router();

const MAX_TARGETS_PER_SITE = 32;

// ── credentials ─────────────────────────────────────────────────────────────

const secretText = z.string().min(1).max(128);
const credentials = z.discriminatedUnion('version', [
  z.object({ version: z.literal('2c'), community: secretText }).strict(),
  z
    .object({
      version: z.literal('3'),
      username: z.string().min(1).max(64),
      auth_protocol: z.enum(['md5', 'sha', 'sha256']).optional(),
      auth_password: secretText.min(8).optional(),
      priv_protocol: z.enum(['des', 'aes']).optional(),
      priv_password: secretText.min(8).optional(),
    })
    .strict()
    .refine((c) => Boolean(c.auth_protocol) === Boolean(c.auth_password), 'authentication protocol and password go together')
    .refine((c) => Boolean(c.priv_protocol) === Boolean(c.priv_password), 'privacy protocol and password go together')
    .refine((c) => !c.priv_protocol || Boolean(c.auth_protocol), 'privacy needs authentication'),
]);
type Credentials = z.infer<typeof credentials>;

const seal = (c: Credentials): string => {
  const { version: _version, ...secret } = c;
  return encryptSecret(JSON.stringify(secret));
};

/** Targets for the collector's configuration. The only place credentials are decrypted. */
export async function buildSnmpConfig(db: Db, siteId: string) {
  const rows = (
    await db.query<{ id: string; host: string; port: number; version: string; secret_enc: string; poll_interval_seconds: number }>(
      `SELECT t.id, host(t.host) AS host, t.port, t.version, t.secret_enc, t.poll_interval_seconds
         FROM snmp_targets t
        WHERE t.site_id = $1 AND t.enabled
          AND EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = t.site_id AND s.enabled AND t.host <<= s.cidr)
        ORDER BY t.host`,
      [siteId],
    )
  ).rows;
  return {
    targets: rows.flatMap((r) => {
      try {
        return [{ id: r.id, host: r.host, port: r.port, version: r.version, interval_seconds: r.poll_interval_seconds, ...(JSON.parse(decryptSecret(r.secret_enc)) as object) }];
      } catch {
        return []; // undecryptable (key changed): the switch shows as never read until credentials are re-entered
      }
    }),
  };
}

// ── switches ────────────────────────────────────────────────────────────────

const SUMMARY = `
  SELECT t.id, t.site_id, t.device_id, coalesce(t.name, t.sys_name, host(t.host)) AS name, host(t.host) AS host, t.port, t.version, t.enabled,
         t.poll_interval_seconds, t.last_polled_at, t.last_ok_at, t.last_status, t.last_error, t.sys_name, t.sys_descr, t.truncated,
         EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = t.site_id AND s.enabled AND t.host <<= s.cidr) AS in_scope,
         (SELECT count(*)::int FROM switch_ports p WHERE p.target_id = t.id) AS port_count,
         (SELECT count(*)::int FROM switch_ports p WHERE p.target_id = t.id AND p.oper_up) AS ports_up,
         (SELECT count(DISTINCT f.mac)::int FROM switch_fdb f WHERE f.target_id = t.id) AS address_count
    FROM snmp_targets t`;

const listQuery = z.object({ site_id: z.uuid().optional() });

portsRouter.get('/switches', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(listQuery, req.query);
  const items = await withTenant(ctx.organizationId, async (db) =>
    (await db.query<SwitchSummary>(`${SUMMARY} WHERE ($1::uuid IS NULL OR t.site_id = $1) ORDER BY t.host`, [site_id ?? null])).rows,
  );
  res.json({ items });
});

const createBody = z
  .object({
    site_id: z.uuid(),
    host: z.ipv4(),
    port: z.number().int().min(1).max(65535).default(161),
    name: z.string().trim().min(1).max(80).optional(),
    credentials,
  })
  .strict();

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

portsRouter.post('/switches', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(createBody, req.body);
  const created = await withTenant(ctx.organizationId, async (db) => {
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
  res.status(201).json(created);
});

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(80).nullable().optional(),
    enabled: z.boolean().optional(),
    poll_interval_seconds: z.number().int().min(60).max(86400).optional(),
    credentials: credentials.optional(),
  })
  .strict();

portsRouter.patch('/switches/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(patchBody, req.body);
  await withTenant(ctx.organizationId, async (db) => {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (body.name !== undefined) set('name', body.name);
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
  res.json({ ok: true });
});

portsRouter.delete('/switches/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query(`DELETE FROM snmp_targets WHERE id = $1`, [id]);
    if (!r.rowCount) throw notFound('Switch');
    await audit(db, req, 'switch.remove', { type: 'snmp_target', id }, {});
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.status(204).end();
});

portsRouter.post('/switches/:id/poll', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const queued = await withTenant(ctx.organizationId, async (db) => {
    const t = (await db.query<{ site_id: string }>(`SELECT site_id FROM snmp_targets WHERE id = $1`, [id])).rows[0];
    if (!t) throw notFound('Switch');
    return queuePoll(db, ctx.organizationId, t.site_id, ctx.userId);
  });
  if (!queued) throw new AppError(409, 'no_collector', 'No collector of this site is online to read the switch');
  res.status(202).json({ queued: true });
});

portsRouter.get('/switches/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const detail = await withTenant(ctx.organizationId, async (db): Promise<SwitchDetail> => {
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
  res.json(detail);
});

// ── traffic and error history of one port ──────────────────────────────────

// Bucket sizes keep a chart at a few hundred points. Reads normally arrive every 5 minutes.
const HISTORY: Record<string, { seconds: number; bucket: number }> = {
  '6h': { seconds: 21_600, bucket: 300 },
  '24h': { seconds: 86_400, bucket: 300 },
  '7d': { seconds: 604_800, bucket: 3600 },
  '30d': { seconds: 2_592_000, bucket: 14_400 },
};

portsRouter.get('/switches/:id/ports/:ifIndex/history', async (req, res) => {
  const ctx = auth(req);
  const { id, ifIndex } = parse(z.object({ id: z.uuid(), ifIndex: z.coerce.number().int().min(0).max(2_147_483_647) }), req.params);
  const { range } = parse(z.object({ range: z.enum(['6h', '24h', '7d', '30d']).default('24h') }), req.query);
  const r = HISTORY[range]!;
  const to = new Date();
  const from = new Date(to.getTime() - r.seconds * 1000);
  const data = await withTenant(ctx.organizationId, async (db) => {
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
  res.json({ from, to, bucket_seconds: r.bucket, ...data });
});

// ── where is this device? ───────────────────────────────────────────────────

async function sightingsFor(db: Db, deviceId: string): Promise<{ found: boolean; mac: string | null; sightings: Sighting[]; switches: number }> {
  const device = (await db.query<{ site_id: string; mac: string | null }>(`SELECT site_id, primary_mac::text AS mac FROM devices WHERE id = $1`, [deviceId])).rows[0];
  if (!device) return { found: false, mac: null, sightings: [], switches: 0 };
  const switches = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM snmp_targets WHERE site_id = $1 AND last_status = 'ok'`, [device.site_id])).rows[0]!.n;
  if (!device.mac) return { found: true, mac: null, sightings: [], switches };
  const rows = (
    await db.query<Sighting>(
      `SELECT t.id AS target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, host(t.host) AS switch_host, f.if_index, p.name AS port_name, p.alias AS port_alias,
              f.vlan, p.mac_count, p.neighbors, p.oper_up, p.speed_mbps::int AS speed_mbps, f.last_seen_at
         FROM switch_fdb f
         JOIN snmp_targets t ON t.id = f.target_id AND t.site_id = $1
         JOIN switch_ports p ON p.target_id = f.target_id AND p.if_index = f.if_index
        WHERE f.mac = $2::macaddr`,
      [device.site_id, device.mac],
    )
  ).rows;
  return { found: true, mac: device.mac, sightings: rows, switches };
}

portsRouter.get('/devices/:id/port', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const data = await withTenant(ctx.organizationId, async (db) => {
    const s = await sightingsFor(db, id);
    if (!s.found) throw notFound('Device');
    const location = locate(s.sightings) as PortLocationDto | null;
    return {
      location,
      // Every switch that saw the address, so the path can be followed by hand.
      seen_on: s.sightings.map((x) => ({ target_id: x.target_id, switch_name: x.switch_name, port_name: x.port_name, mac_count: x.mac_count, vlan: x.vlan })),
      switches_read: s.switches,
      reason: location ? null : !s.mac ? 'no_mac' : s.switches === 0 ? 'no_switches' : 'not_seen',
    };
  });
  res.json(data);
});

const findQuery = z.object({ q: z.string().trim().min(2).max(100), site_id: z.uuid().optional() });

/** Port Detective search: a name, IP or MAC → the port(s) it is on. */
portsRouter.get('/ports/find', async (req, res) => {
  const ctx = auth(req);
  const { q, site_id } = parse(findQuery, req.query);
  const items = await withTenant(ctx.organizationId, async (db) => {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const devices = (
      await db.query<{ id: string; label: string; ip: string | null; mac: string | null; status: string }>(
        `SELECT id, coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS label, host(current_ip) AS ip, primary_mac::text AS mac, status
           FROM devices
          WHERE ($2::uuid IS NULL OR site_id = $2)
            AND (display_name ILIKE $1 OR hostname ILIKE $1 OR host(current_ip) ILIKE $1 OR primary_mac::text ILIKE $1 OR vendor ILIKE $1)
          ORDER BY (status = 'online') DESC, current_ip NULLS LAST LIMIT 20`,
        [like, site_id ?? null],
      )
    ).rows;
    const out = [];
    for (const d of devices) {
      const s = await sightingsFor(db, d.id);
      out.push({ device: d, location: locate(s.sightings) });
    }
    return out;
  });
  res.json({ items });
});
