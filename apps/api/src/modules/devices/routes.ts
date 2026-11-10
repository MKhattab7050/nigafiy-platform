import { Router } from 'express';
import { z } from 'zod';
import { DEVICE_TRUSTS, type Device, type DeviceDetail, type NetworkEvent, type Paginated } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../events/emit.ts';
import { EVENT_SELECT } from '../events/routes.ts';

export const devicesRouter: Router = Router();

const DEVICE_TYPES = ['windows_computer', 'linux_computer', 'server', 'router', 'switch', 'firewall', 'printer', 'access_point', 'camera', 'nas', 'iot', 'mobile', 'apple_computer', 'media_player', 'unknown'] as const;

const DEVICE_SELECT = `
  SELECT d.id, d.site_id, s.name AS site_name, d.display_name, d.hostname, host(d.current_ip) AS current_ip,
         d.primary_mac::text AS primary_mac, d.mac_randomized, d.identity_basis, d.vendor, d.device_type, d.type_source,
         d.type_evidence, d.type_confidence, d.name_source, d.fingerprint, d.status, d.is_critical, d.trust, d.trust_changed_at, d.alerts_muted,
         (SELECT c.id FROM monitoring_checks c WHERE c.device_id = d.id ORDER BY c.created_at LIMIT 1) AS monitor_check_id, d.owner, d.notes, d.discovery_sources, d.first_seen_at, d.last_seen_at,
         coalesce((SELECT array_agg(t.tag ORDER BY t.tag) FROM device_tags t WHERE t.device_id = d.id), '{}') AS tags
    FROM devices d JOIN sites s ON s.id = d.site_id`;

const SORTS: Record<string, string> = {
  ip: 'd.current_ip ASC NULLS LAST',
  name: 'lower(coalesce(d.display_name, d.hostname)) ASC NULLS LAST, d.current_ip',
  last_seen: 'd.last_seen_at DESC',
  first_seen: 'd.first_seen_at DESC',
  status: `array_position(ARRAY['offline','unknown','online'], d.status), d.current_ip`,
};

const listQuery = z.object({
  site_id: z.uuid().optional(),
  status: z.enum(['online', 'offline', 'unknown']).optional(),
  device_type: z.enum(DEVICE_TYPES).optional(),
  trust: z.enum(DEVICE_TRUSTS).optional(),
  q: z.string().trim().max(100).optional(),
  new_within_hours: z.coerce.number().int().min(1).max(24 * 30).optional(),
  sort: z.enum(['ip', 'name', 'last_seen', 'first_seen', 'status']).default('ip'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

devicesRouter.get('/devices', async (req, res) => {
  const ctx = auth(req);
  const q = parse(listQuery, req.query);
  // LIKE wildcards in user input are escaped so the search term is always literal.
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const result = await withTenant(ctx.organizationId, (db) =>
    db.query<Device & { total: string }>(
      `${DEVICE_SELECT}
        WHERE ($1::uuid IS NULL OR d.site_id = $1)
          AND ($2::text IS NULL OR d.status = $2)
          AND ($3::text IS NULL OR d.device_type = $3)
          AND ($4::int IS NULL OR d.first_seen_at > now() - make_interval(hours => $4))
          AND ($8::text IS NULL OR d.trust = $8)
          AND ($5::text IS NULL
               OR d.hostname ILIKE $5 OR d.display_name ILIKE $5 OR host(d.current_ip) ILIKE $5
               OR d.primary_mac::text ILIKE $5 OR d.vendor ILIKE $5 OR d.owner ILIKE $5
               OR EXISTS (SELECT 1 FROM device_tags t WHERE t.device_id = d.id AND t.tag ILIKE $5))
        ORDER BY ${SORTS[q.sort]}
        LIMIT $6 OFFSET $7`.replace('SELECT d.id', 'SELECT count(*) OVER() AS total, d.id'),
      [q.site_id ?? null, q.status ?? null, q.device_type ?? null, q.new_within_hours ?? null, like, q.page_size, (q.page - 1) * q.page_size, q.trust ?? null],
    ),
  );
  const total = Number(result.rows[0]?.total ?? 0);
  const response: Paginated<Device> = {
    items: result.rows.map(({ total: _total, ...device }) => device),
    total,
    page: q.page,
    page_size: q.page_size,
  };
  res.json(response);
});

devicesRouter.get('/devices/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const detail = await withTenant(ctx.organizationId, async (db) => {
    const device = (await db.query<Device>(`${DEVICE_SELECT} WHERE d.id = $1`, [id])).rows[0];
    if (!device) throw notFound('Device');
    const ipHistory = await db.query<DeviceDetail['ip_history'][number]>(
      `SELECT host(ip) AS ip, first_seen_at, last_seen_at FROM device_ip_history WHERE device_id = $1 ORDER BY last_seen_at DESC LIMIT 50`,
      [id],
    );
    const availability = await db.query<DeviceDetail['availability'][number]>(
      `SELECT status, started_at, ended_at FROM availability_history
        WHERE device_id = $1 AND coalesce(ended_at, now()) > now() - interval '7 days' ORDER BY started_at`,
      [id],
    );
    const events = await db.query<NetworkEvent>(`${EVENT_SELECT} WHERE e.device_id = $1 ORDER BY e.occurred_at DESC LIMIT 50`, [id]);
    return { ...device, ip_history: ipHistory.rows, availability: availability.rows, recent_events: events.rows } satisfies DeviceDetail;
  });
  res.json(detail);
});

const patchSchema = z
  .object({
    display_name: z.string().trim().max(80).nullable(),
    device_type: z.enum(DEVICE_TYPES),
    owner: z.string().trim().max(80).nullable(),
    notes: z.string().trim().max(4000).nullable(),
    is_critical: z.boolean(),
    trust: z.enum(DEVICE_TRUSTS),
    alerts_muted: z.boolean(),
    tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20),
  })
  .partial()
  .strict();

devicesRouter.patch('/devices/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(patchSchema, req.body);
  await withTenant(ctx.organizationId, async (db) => {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (body.display_name !== undefined) set('display_name', body.display_name || null);
    if (body.owner !== undefined) set('owner', body.owner || null);
    if (body.notes !== undefined) set('notes', body.notes || null);
    if (body.is_critical !== undefined) set('is_critical', body.is_critical);
    if (body.alerts_muted !== undefined) set('alerts_muted', body.alerts_muted);
    if (body.trust !== undefined) {
      set('trust', body.trust);
      sets.push('trust_changed_at = now()');
    }
    if (body.device_type !== undefined) {
      set('device_type', body.device_type);
      sets.push(`type_source = 'manual'`, `type_evidence = NULL`, `type_confidence = NULL`);
    }
    if (sets.length) {
      const updated = await db.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $1`, values);
      if (!updated.rowCount) throw notFound('Device');
    } else if (!(await db.query(`SELECT 1 FROM devices WHERE id = $1`, [id])).rowCount) {
      throw notFound('Device');
    }
    if (body.tags) {
      const tags = [...new Set(body.tags)];
      await db.query(`DELETE FROM device_tags WHERE device_id = $1 AND NOT (tag = ANY($2))`, [id, tags]);
      await db.query(
        `INSERT INTO device_tags (device_id, organization_id, tag) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`,
        [id, ctx.organizationId, tags],
      );
    }
    await audit(db, req, 'device.updated', { type: 'device', id }, { fields: Object.keys(body) });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.json({ ok: true });
});

// ── controls ─────────────────────────────────────────────────────────────────

/** Approve (or flag) many devices at once — e.g. "everything I see right now is mine". */
const bulkTrustSchema = z
  .object({
    trust: z.enum(DEVICE_TRUSTS),
    ids: z.array(z.uuid()).min(1).max(500).optional(),
    all_unreviewed: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.ids) !== Boolean(b.all_unreviewed), 'Give either ids or all_unreviewed');

devicesRouter.post('/devices/trust', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(bulkTrustSchema, req.body);
  const updated = await withTenant(ctx.organizationId, async (db) => {
    const result = body.ids
      ? await db.query(`UPDATE devices SET trust = $2, trust_changed_at = now() WHERE id = ANY($1) AND trust <> $2`, [body.ids, body.trust])
      : await db.query(`UPDATE devices SET trust = $1, trust_changed_at = now() WHERE trust = 'unreviewed'`, [body.trust]);
    await audit(db, req, 'device.trust_bulk', { type: 'device', id: null }, { trust: body.trust, count: result.rowCount, all_unreviewed: Boolean(body.all_unreviewed) });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return result.rowCount ?? 0;
  });
  res.json({ updated });
});

/** One-click monitoring: a ping check that follows the device when its IP address changes. */
devicesRouter.post('/devices/:id/monitor', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const result = await withTenant(ctx.organizationId, async (db) => {
    const device = (
      await db.query<{ site_id: string; ip: string | null; label: string }>(
        `SELECT site_id, host(current_ip) AS ip, coalesce(display_name, hostname, host(current_ip)) AS label FROM devices WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!device) throw notFound('Device');
    if (!device.ip) throw new AppError(409, 'no_address', 'This device has no known IP address to monitor');
    const existing = await db.query<{ id: string }>(`SELECT id FROM monitoring_checks WHERE device_id = $1 LIMIT 1`, [id]);
    if (existing.rowCount) return { check_id: existing.rows[0]!.id, created: false };
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO monitoring_checks (organization_id, site_id, device_id, name, kind, role, target, interval_seconds, failure_threshold, latency_warn_ms, loss_warn_pct)
       VALUES ($1,$2,$3,$4,'icmp','service',$5,60,3,200,20) RETURNING id`,
      [ctx.organizationId, device.site_id, id, `Ping ${device.label}`.slice(0, 80), device.ip],
    );
    const checkId = inserted.rows[0]!.id;
    await audit(db, req, 'check.created', { type: 'monitoring_check', id: checkId }, { from_device: id, target: device.ip });
    await notifyRealtime(db, ctx.organizationId, 'checks');
    return { check_id: checkId, created: true };
  });
  res.status(result.created ? 201 : 200).json(result);
});

/**
 * Wake-on-LAN: the site's collector broadcasts a magic packet for this device's MAC inside the
 * authorized scope that contains the device. Works only if Wake-on-LAN is enabled on the device.
 */
devicesRouter.post('/devices/:id/wake', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const result = await withTenant(ctx.organizationId, async (db) => {
    const device = (
      await db.query<{ site_id: string; mac: string | null; ip: string | null }>(
        `SELECT site_id, primary_mac::text AS mac, host(current_ip) AS ip FROM devices WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!device) throw notFound('Device');
    if (!device.mac) throw new AppError(409, 'no_mac', 'Wake-on-LAN needs the device’s MAC address, which has not been observed');
    if (!device.ip) throw new AppError(409, 'no_address', 'The device’s network is unknown');
    const scope = (
      await db.query<{ broadcast: string }>(
        `SELECT host(broadcast(cidr)) AS broadcast FROM network_scopes WHERE site_id = $1 AND enabled AND $2::inet <<= cidr ORDER BY masklen(cidr) DESC LIMIT 1`,
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
    await db.query(
      `INSERT INTO collector_commands (organization_id, collector_id, kind, payload, created_by) VALUES ($1,$2,'wake_device',$3,$4)`,
      [ctx.organizationId, collector.id, JSON.stringify({ mac: device.mac, broadcast: scope.broadcast }), ctx.userId],
    );
    await audit(db, req, 'device.wake', { type: 'device', id }, { mac: device.mac, collector: collector.id });
    return { queued: true, collector: collector.name, broadcast: scope.broadcast };
  });
  res.status(202).json(result);
});
