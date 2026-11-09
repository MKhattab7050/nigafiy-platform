import { Router } from 'express';
import { z } from 'zod';
import type { Device, DeviceDetail, NetworkEvent, Paginated } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../events/emit.ts';
import { EVENT_SELECT } from '../events/routes.ts';

export const devicesRouter: Router = Router();

const DEVICE_TYPES = ['windows_computer', 'linux_computer', 'server', 'router', 'switch', 'firewall', 'printer', 'access_point', 'camera', 'nas', 'iot', 'unknown'] as const;

const DEVICE_SELECT = `
  SELECT d.id, d.site_id, s.name AS site_name, d.display_name, d.hostname, host(d.current_ip) AS current_ip,
         d.primary_mac::text AS primary_mac, d.mac_randomized, d.identity_basis, d.vendor, d.device_type, d.type_source,
         d.type_evidence, d.status, d.is_critical, d.owner, d.notes, d.discovery_sources, d.first_seen_at, d.last_seen_at,
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
          AND ($5::text IS NULL
               OR d.hostname ILIKE $5 OR d.display_name ILIKE $5 OR host(d.current_ip) ILIKE $5
               OR d.primary_mac::text ILIKE $5 OR d.vendor ILIKE $5 OR d.owner ILIKE $5
               OR EXISTS (SELECT 1 FROM device_tags t WHERE t.device_id = d.id AND t.tag ILIKE $5))
        ORDER BY ${SORTS[q.sort]}
        LIMIT $6 OFFSET $7`.replace('SELECT d.id', 'SELECT count(*) OVER() AS total, d.id'),
      [q.site_id ?? null, q.status ?? null, q.device_type ?? null, q.new_within_hours ?? null, like, q.page_size, (q.page - 1) * q.page_size],
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
    if (body.device_type !== undefined) {
      set('device_type', body.device_type);
      sets.push(`type_source = 'manual'`, `type_evidence = NULL`);
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
