import type { Request } from 'express';
import { audit } from '../../../common/audit.ts';
import { type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { ACCESS_CATEGORIES, internetOff, mergeRules } from '../policy.ts';
import { type DeviceAccessRow, type ProfileRow, deviceLayer, siteAccess } from '../repo.ts';
import type { SettingsBody } from '../schema.ts';

// Site-level access control: the full picture of a site (settings, profiles, setup status, every
// device with its effective rule) and the site-wide settings. `req` is passed only for the audit trail.

const PROTECTED_WITHIN_MINUTES = 30;

export function getSiteAccess(organizationId: string, site_id: string) {
  const now = new Date();
  return withTenant(organizationId, async (db) => {
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
}

export async function updateSettings(req: Request, ctx: AuthContext, body: SettingsBody): Promise<void> {
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
}
