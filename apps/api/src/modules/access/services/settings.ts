import type { AccessEnforcementMode, DeviceEnforcementMode } from '@lan-detective/shared-types';
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
    const onlineCollectorCount = (
      await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM collectors WHERE site_id = $1 AND status = 'active' AND last_heartbeat_at > now() - interval '3 minutes'`,
        [site_id],
      )
    ).rows[0]?.count ?? 0;
    const activeRouterCount = (
      await db.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM site_routers
          WHERE site_id = $1 AND enabled = true AND status = 'ok'
            AND jsonb_typeof(capabilities) = 'array'
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(capabilities) AS c
               WHERE c->>'capability' = 'block' AND c->>'supported' = 'true'
            )`,
        [site_id],
      )
    ).rows[0]?.count ?? 0;

    // Active hard router blocks & product-enforced router schedules for devices on this site.
    const routerBlockRows = (
      await db.query<{ device_id: string | null; mac: string }>(
        `SELECT DISTINCT device_id, lower(mac::text) AS mac
           FROM router_blocks
          WHERE site_id = $1 AND released_at IS NULL`,
        [site_id],
      )
    ).rows;
    const routerScheduleRows = (
      await db.query<{ device_id: string | null; mac: string }>(
        `SELECT DISTINCT device_id, lower(mac::text) AS mac
           FROM router_product_schedules
          WHERE site_id = $1 AND removing = false`,
        [site_id],
      )
    ).rows;
    const blockedDeviceIds = new Set(routerBlockRows.map((r) => r.device_id).filter(Boolean));
    const blockedMacs = new Set(routerBlockRows.map((r) => r.mac));
    const scheduledDeviceIds = new Set(routerScheduleRows.map((r) => r.device_id).filter(Boolean));
    const scheduledMacs = new Set(routerScheduleRows.map((r) => r.mac));

    // Encrypted-DNS / DoH bypass attempts recorded over the last 24h (per device + site-wide).
    const dohRows = (
      await db.query<{ device_id: string | null; domain: string; count: number }>(
        `SELECT x.device_id,
                elem->>'domain' AS domain,
                sum(coalesce((elem->>'blocked')::int, 0))::int AS count
           FROM dns_stats x,
                jsonb_array_elements(x.top_domains) AS elem
          WHERE x.site_id = $1
            AND x.window_end > $2::timestamptz - interval '24 hours'
            AND (elem->>'reason' = 'encrypted_dns' OR elem->>'category' = 'encrypted_dns')
            AND coalesce((elem->>'blocked')::int, 0) > 0
          GROUP BY x.device_id, elem->>'domain'
          ORDER BY count DESC`,
        [site_id, now],
      )
    ).rows;
    const dohByDevice = new Map<string, { count: number; domains: string[] }>();
    const dohDomainTotals = new Map<string, number>();
    let dohTotalQueries = 0;
    for (const row of dohRows) {
      dohTotalQueries += row.count;
      dohDomainTotals.set(row.domain, (dohDomainTotals.get(row.domain) ?? 0) + row.count);
      if (row.device_id) {
        const cur = dohByDevice.get(row.device_id) ?? { count: 0, domains: [] };
        cur.count += row.count;
        if (cur.domains.length < 8 && !cur.domains.includes(row.domain)) cur.domains.push(row.domain);
        dohByDevice.set(row.device_id, cur);
      }
    }
    const topDohDomains = [...dohDomainTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([domain, count]) => ({ domain, count }));

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
    const dnsListening = Boolean(settings.enabled && collector?.online && (collector.access_status as { listening?: boolean } | null)?.listening);
    const hasRouter = activeRouterCount > 0;
    const siteMode: AccessEnforcementMode =
      hasRouter && dnsListening ? 'router_and_dns' : hasRouter ? 'router_only' : dnsListening ? 'dns_only' : 'none';

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
      enforcement: {
        mode: siteMode,
        dns_active: dnsListening,
        active_router_count: activeRouterCount,
        online_collector_count: onlineCollectorCount,
        single_point_of_failure: dnsListening && onlineCollectorCount <= 1,
        doh_bypass_queries_24h: dohTotalQueries,
        doh_bypass_devices_24h: dohByDevice.size,
        top_doh_domains_24h: topDohDomains,
      },
      devices: devices.map((d) => {
        const rule = mergeRules(now, settings, d.access_profile_id ? profileById.get(d.access_profile_id) : null, deviceLayer(d));
        const macLower = d.mac?.toLowerCase() ?? '';
        const dnsProtected = Boolean(d.last_query && new Date(d.last_query).getTime() > protectedSince);
        const routerBlocked = blockedDeviceIds.has(d.id) || (macLower ? blockedMacs.has(macLower) : false);
        const routerScheduled = scheduledDeviceIds.has(d.id) || (macLower ? scheduledMacs.has(macLower) : false);
        // A router being connected is not enforcement by itself: only a block or schedule that is
        // actually on the router for this device is. DNS rules (categories, domains) stay DNS-level.
        const hasRouterCoverage = routerBlocked || routerScheduled;
        const enforcementMode: DeviceEnforcementMode =
          hasRouterCoverage && dnsProtected ? 'router_and_dns' : hasRouterCoverage ? 'router_only' : dnsProtected ? 'dns_only' : 'unprotected';
        const doh = dohByDevice.get(d.id);
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
          protected: dnsProtected,
          queries_24h: d.queries ?? 0,
          blocked_24h: d.blocked ?? 0,
          enforcement_mode: enforcementMode,
          router_blocked: routerBlocked,
          router_scheduled: routerScheduled,
          doh_bypass_24h: doh?.count ?? 0,
          doh_domains_24h: doh?.domains ?? [],
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
