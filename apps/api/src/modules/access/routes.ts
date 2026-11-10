import { Router } from 'express';
import type { Db } from '../../infrastructure/db.ts';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../events/emit.ts';
import { ACCESS_CATEGORIES, type EffectiveRule, type RuleLayer, domainList, internetOff, mergeRules, scheduleSchema } from './policy.ts';

export const accessRouter: Router = Router();

const PROTECTED_WITHIN_MINUTES = 30;

interface SiteAccessRow extends RuleLayer {
  enabled: boolean;
  upstreams: string[];
  updated_at: string | null;
}

interface ProfileRow extends RuleLayer {
  id: string;
  name: string;
  schedule: z.infer<typeof scheduleSchema>;
  paused_until: string | null;
}

interface DeviceAccessRow {
  id: string;
  mac: string | null;
  ip: string | null;
  access_profile_id: string | null;
  internet_paused_until: string | null;
  access_blocked_domains: string[];
  access_allowed_domains: string[];
  access_schedule: z.infer<typeof scheduleSchema>;
}

async function siteAccess(db: Db, siteId: string): Promise<SiteAccessRow> {
  const row = (
    await db.query<SiteAccessRow>(
      `SELECT enabled, blocked_categories, blocked_domains, allowed_domains, upstreams, updated_at FROM site_access WHERE site_id = $1`,
      [siteId],
    )
  ).rows[0];
  return row ?? { enabled: false, blocked_categories: [], blocked_domains: [], allowed_domains: [], upstreams: [], updated_at: null };
}

const deviceLayer = (d: DeviceAccessRow): RuleLayer => ({
  blocked_categories: [],
  blocked_domains: d.access_blocked_domains,
  allowed_domains: d.access_allowed_domains,
  schedule: d.access_schedule,
  paused_until: d.internet_paused_until,
});

/** The policy delivered to the site's collector in every heartbeat. */
export async function buildAccessPolicy(db: Db, siteId: string, now: Date) {
  const site = await siteAccess(db, siteId);
  if (!site.enabled) return { enabled: false };
  const profiles = new Map(
    (
      await db.query<ProfileRow>(
        `SELECT id, name, blocked_categories, blocked_domains, allowed_domains, schedule, paused_until FROM access_profiles WHERE site_id = $1`,
        [siteId],
      )
    ).rows.map((p) => [p.id, p]),
  );
  const devices = (
    await db.query<DeviceAccessRow>(
      `SELECT id, primary_mac::text AS mac, host(current_ip) AS ip, access_profile_id, internet_paused_until,
              access_blocked_domains, access_allowed_domains, access_schedule
         FROM devices
        WHERE site_id = $1 AND (access_profile_id IS NOT NULL OR internet_paused_until > $2 OR access_blocked_domains <> '{}'
              OR access_allowed_domains <> '{}' OR access_schedule <> '[]'::jsonb)`,
      [siteId, now],
    )
  ).rows;
  const clients = devices
    .filter((d) => d.mac || d.ip)
    .map((d) => ({
      mac: d.mac ?? '',
      // A MAC identifies a device across IP changes; the IP is only a fallback when the MAC is unknown.
      ip: d.mac ? '' : (d.ip ?? ''),
      rule: mergeRules(now, site, d.access_profile_id ? profiles.get(d.access_profile_id) : null, deviceLayer(d)),
    }));
  return {
    enabled: true,
    upstreams: site.upstreams,
    default: mergeRules(now, site),
    clients,
  };
}

// ── settings ────────────────────────────────────────────────────────────────

const siteQuery = z.object({ site_id: z.uuid() });

accessRouter.get('/access', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(siteQuery, req.query);
  const now = new Date();
  const data = await withTenant(ctx.organizationId, async (db) => {
    const siteRow = (await db.query<{ timezone: string }>(`SELECT timezone FROM sites WHERE id = $1`, [site_id])).rows[0];
    if (!siteRow) throw notFound('Site');
    const settings = await siteAccess(db, site_id);
    const profiles = (
      await db.query<ProfileRow & { device_count: number }>(
        `SELECT p.id, p.name, p.blocked_categories, p.blocked_domains, p.allowed_domains, p.schedule, p.paused_until,
                (SELECT count(*)::int FROM devices d WHERE d.access_profile_id = p.id) AS device_count
           FROM access_profiles p WHERE p.site_id = $1 ORDER BY p.name`,
        [site_id],
      )
    ).rows;
    const collector = (
      await db.query<{ id: string; name: string; hostname: string | null; online: boolean; access_status: Record<string, unknown> | null; interfaces: { name: string; addresses: string[] }[] | null }>(
        `SELECT id, name, hostname, last_heartbeat_at > now() - interval '3 minutes' AS online, access_status, interfaces
           FROM collectors WHERE site_id = $1 AND status = 'active' ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1`,
        [site_id],
      )
    ).rows[0];
    // The address devices must use as DNS: the collector host's own address inside an authorized range.
    const hostIp = collector
      ? (
          await db.query<{ ip: string }>(
            `SELECT host(x.addr::inet) AS ip FROM unnest($1::text[]) AS x(addr)
              WHERE x.addr ~ '^\\d+\\.\\d+\\.\\d+\\.\\d+(/\\d+)?$'
                AND EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = $2 AND s.enabled AND host(x.addr::inet)::inet <<= s.cidr)
              LIMIT 1`,
            [(collector.interfaces ?? []).flatMap((i) => i.addresses), site_id],
          )
        ).rows[0]?.ip ?? null
      : null;
    const gateway = (
      await db.query<{ gateway_ip: string | null }>(`SELECT host(gateway_ip) AS gateway_ip FROM collectors WHERE id = $1`, [collector?.id ?? null])
    ).rows[0]?.gateway_ip ?? null;
    const devices = (
      await db.query<
        DeviceAccessRow & { name: string; device_type: string; status: string; trust: string; profile_name: string | null; queries: number | null; blocked: number | null; last_query: string | null }
      >(
        `SELECT d.id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS name, d.device_type, d.status, d.trust,
                d.primary_mac::text AS mac, host(d.current_ip) AS ip, d.access_profile_id, p.name AS profile_name, d.internet_paused_until,
                d.access_blocked_domains, d.access_allowed_domains, d.access_schedule,
                s.queries, s.blocked, s.last_query
           FROM devices d
           LEFT JOIN access_profiles p ON p.id = d.access_profile_id
           LEFT JOIN LATERAL (
             SELECT sum(queries)::int AS queries, sum(blocked)::int AS blocked, max(window_end) AS last_query
               FROM dns_stats x WHERE x.device_id = d.id AND x.window_end > $2::timestamptz - interval '24 hours'
           ) s ON true
          WHERE d.site_id = $1
          ORDER BY (d.access_profile_id IS NULL), lower(coalesce(d.display_name, d.hostname, '')), d.current_ip`,
        [site_id, now],
      )
    ).rows;
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const protectedSince = now.getTime() - PROTECTED_WITHIN_MINUTES * 60_000;
    return {
      categories: ACCESS_CATEGORIES,
      settings: { ...settings, upstreams: settings.upstreams },
      profiles,
      setup: {
        collector: collector ? { id: collector.id, name: collector.name, hostname: collector.hostname, online: collector.online } : null,
        status: collector?.access_status ?? null,
        dns_server_ip: hostIp,
        gateway_ip: gateway,
        protected_devices: devices.filter((d) => d.last_query && new Date(d.last_query).getTime() > protectedSince).length,
        protected_within_minutes: PROTECTED_WITHIN_MINUTES,
      },
      devices: devices.map((d) => {
        const rule = mergeRules(now, settings, d.access_profile_id ? profileById.get(d.access_profile_id) : null, deviceLayer(d));
        return {
          id: d.id,
          name: d.name,
          device_type: d.device_type,
          status: d.status,
          trust: d.trust,
          mac: d.mac,
          ip: d.ip,
          profile_id: d.access_profile_id,
          profile_name: d.profile_name,
          paused_until: d.internet_paused_until && new Date(d.internet_paused_until) > now ? d.internet_paused_until : null,
          blocked_domains: d.access_blocked_domains,
          allowed_domains: d.access_allowed_domains,
          schedule: d.access_schedule,
          internet_off: settings.enabled ? internetOff(rule, now, siteRow.timezone) : null,
          protected: Boolean(d.last_query && new Date(d.last_query).getTime() > protectedSince),
          queries_24h: d.queries ?? 0,
          blocked_24h: d.blocked ?? 0,
        };
      }),
    };
  });
  res.json(data);
});

const settingsBody = z
  .object({
    site_id: z.uuid(),
    enabled: z.boolean().optional(),
    blocked_categories: z.array(z.enum(ACCESS_CATEGORIES)).max(ACCESS_CATEGORIES.length).optional(),
    blocked_domains: domainList.optional(),
    allowed_domains: domainList.optional(),
    upstreams: z.array(z.ipv4()).max(4).optional(),
  })
  .strict();

accessRouter.put('/access/settings', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(settingsBody, req.body);
  await withTenant(ctx.organizationId, async (db) => {
    const site = (await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount;
    if (!site) throw notFound('Site');
    const cur = await siteAccess(db, body.site_id);
    const next = {
      enabled: body.enabled ?? cur.enabled,
      blocked_categories: [...new Set(body.blocked_categories ?? cur.blocked_categories)],
      blocked_domains: body.blocked_domains ?? cur.blocked_domains,
      allowed_domains: body.allowed_domains ?? cur.allowed_domains,
      upstreams: body.upstreams ?? cur.upstreams,
    };
    await db.query(
      `INSERT INTO site_access (site_id, organization_id, enabled, blocked_categories, blocked_domains, allowed_domains, upstreams, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (site_id) DO UPDATE SET enabled = $3, blocked_categories = $4, blocked_domains = $5, allowed_domains = $6, upstreams = $7, updated_at = now()`,
      [body.site_id, ctx.organizationId, next.enabled, next.blocked_categories, next.blocked_domains, next.allowed_domains, next.upstreams],
    );
    await audit(db, req, 'access.settings', { type: 'site', id: body.site_id }, next);
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.json({ ok: true });
});

// ── profiles ────────────────────────────────────────────────────────────────

const profileBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    blocked_categories: z.array(z.enum(ACCESS_CATEGORIES)).max(ACCESS_CATEGORIES.length).default([]),
    blocked_domains: domainList.default([]),
    allowed_domains: domainList.default([]),
    schedule: scheduleSchema.default([]),
  })
  .strict();

accessRouter.post('/access/profiles', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(siteQuery, req.query);
  const body = parse(profileBody, req.body);
  const created = await withTenant(ctx.organizationId, async (db) => {
    const exists = (await db.query(`SELECT 1 FROM access_profiles WHERE site_id = $1 AND lower(name) = lower($2)`, [site_id, body.name])).rowCount;
    if (exists) throw new AppError(409, 'name_in_use', 'A profile with this name already exists');
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO access_profiles (organization_id, site_id, name, blocked_categories, blocked_domains, allowed_domains, schedule)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.organizationId, site_id, body.name, body.blocked_categories, body.blocked_domains, body.allowed_domains, JSON.stringify(body.schedule)],
      )
    ).rows[0]!;
    await audit(db, req, 'access.profile.create', { type: 'access_profile', id: row.id }, { name: body.name });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return row;
  });
  res.status(201).json(created);
});

accessRouter.patch('/access/profiles/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(profileBody.partial(), req.body);
  await withTenant(ctx.organizationId, async (db) => {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      vals.push(k === 'schedule' ? JSON.stringify(v) : v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) return;
    const r = await db.query(`UPDATE access_profiles SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
    if (!r.rowCount) throw notFound('Profile');
    await audit(db, req, 'access.profile.update', { type: 'access_profile', id }, body);
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.json({ ok: true });
});

accessRouter.delete('/access/profiles/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query(`DELETE FROM access_profiles WHERE id = $1`, [id]);
    if (!r.rowCount) throw notFound('Profile');
    await audit(db, req, 'access.profile.delete', { type: 'access_profile', id }, {});
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.status(204).end();
});

// ── pause ───────────────────────────────────────────────────────────────────

/** minutes: pause the internet for that long; null: resume now. */
const pauseBody = z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60).nullable() }).strict();

function pauseUntil(minutes: number | null, now: Date): Date | null {
  return minutes === null ? null : new Date(now.getTime() + minutes * 60_000);
}

accessRouter.post('/access/profiles/:id/pause', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { minutes } = parse(pauseBody, req.body);
  const until = pauseUntil(minutes, new Date());
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query(`UPDATE access_profiles SET paused_until = $2, updated_at = now() WHERE id = $1`, [id, until]);
    if (!r.rowCount) throw notFound('Profile');
    await audit(db, req, minutes === null ? 'access.profile.resume' : 'access.profile.pause', { type: 'access_profile', id }, { until });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.json({ paused_until: until });
});

accessRouter.post('/devices/:id/pause', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { minutes } = parse(pauseBody, req.body);
  const until = pauseUntil(minutes, new Date());
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query(`UPDATE devices SET internet_paused_until = $2 WHERE id = $1`, [id, until]);
    if (!r.rowCount) throw notFound('Device');
    await audit(db, req, minutes === null ? 'device.internet.resume' : 'device.internet.pause', { type: 'device', id }, { until });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.json({ paused_until: until });
});

// ── per-device rules ────────────────────────────────────────────────────────

const deviceAccessBody = z
  .object({
    profile_id: z.uuid().nullable().optional(),
    blocked_domains: domainList.optional(),
    allowed_domains: domainList.optional(),
    schedule: scheduleSchema.optional(),
  })
  .strict();

accessRouter.patch('/devices/:id/access', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(deviceAccessBody, req.body);
  await withTenant(ctx.organizationId, async (db) => {
    const device = (await db.query<{ site_id: string }>(`SELECT site_id FROM devices WHERE id = $1`, [id])).rows[0];
    if (!device) throw notFound('Device');
    if (body.profile_id) {
      const p = (await db.query(`SELECT 1 FROM access_profiles WHERE id = $1 AND site_id = $2`, [body.profile_id, device.site_id])).rowCount;
      if (!p) throw new AppError(422, 'bad_profile', 'The profile does not belong to this device’s site');
    }
    const cols: Record<string, unknown> = {
      access_profile_id: body.profile_id,
      access_blocked_domains: body.blocked_domains,
      access_allowed_domains: body.allowed_domains,
      access_schedule: body.schedule === undefined ? undefined : JSON.stringify(body.schedule),
    };
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(cols)) {
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (sets.length) await db.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit(db, req, 'device.access', { type: 'device', id }, body);
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.json({ ok: true });
});

// ── activity ────────────────────────────────────────────────────────────────

const activityQuery = z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) });

accessRouter.get('/devices/:id/activity', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const { hours } = parse(activityQuery, req.query);
  const data = await withTenant(ctx.organizationId, async (db) => {
    const exists = (await db.query(`SELECT 1 FROM devices WHERE id = $1`, [id])).rowCount;
    if (!exists) throw notFound('Device');
    const totals = (
      await db.query<{ queries: number; blocked: number; first: string | null; last: string | null }>(
        `SELECT coalesce(sum(queries),0)::int AS queries, coalesce(sum(blocked),0)::int AS blocked, min(window_start) AS first, max(window_end) AS last
           FROM dns_stats WHERE device_id = $1 AND window_end > now() - make_interval(hours => $2)`,
        [id, hours],
      )
    ).rows[0]!;
    const domains = (
      await db.query<{ domain: string; count: number; blocked: number; category: string | null; reason: string | null; last_seen: string }>(
        `SELECT t->>'domain' AS domain, sum((t->>'count')::int)::int AS count, sum((t->>'blocked')::int)::int AS blocked,
                max(t->>'category') AS category, max(t->>'reason') AS reason, max(s.window_end) AS last_seen
           FROM dns_stats s, jsonb_array_elements(s.top_domains) t
          WHERE s.device_id = $1 AND s.window_end > now() - make_interval(hours => $2)
          GROUP BY 1 ORDER BY (sum((t->>'blocked')::int) > 0) DESC, sum((t->>'count')::int) DESC LIMIT 40`,
        [id, hours],
      )
    ).rows;
    const hourly = (
      await db.query<{ hour: string; queries: number; blocked: number }>(
        `SELECT date_trunc('hour', window_end) AS hour, sum(queries)::int AS queries, sum(blocked)::int AS blocked
           FROM dns_stats WHERE device_id = $1 AND window_end > now() - make_interval(hours => $2) GROUP BY 1 ORDER BY 1`,
        [id, hours],
      )
    ).rows;
    return { hours, ...totals, domains, hourly };
  });
  res.json(data);
});

export type { EffectiveRule };
