import { Router } from 'express';
import { z } from 'zod';
import { auth, parse } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { automationSettingsForSites } from '../automation/index.ts';
import { INFRASTRUCTURE_LIMIT, INFRASTRUCTURE_TYPES, type InfrastructureFact, type InsightFacts, buildInsights } from './rules.ts';

export const insightsRouter: Router = Router();

insightsRouter.get('/insights', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(z.object({ site_id: z.uuid().optional() }), req.query);
  const siteFilter = site_id ?? null;
  const facts = await withTenant(ctx.organizationId, (db) => loadInsightFacts(db, ctx.organizationId, siteFilter));
  res.json(buildInsights(facts));
});

/**
 * Gathers the facts the insight rules need, for one site or (siteFilter = null) the whole organization,
 * inside the caller's tenant transaction. Exported through index.ts (the portfolio roll-up reuses it).
 *
 * One transaction = one connection: queries run one after another (pg cannot run them in parallel
 * on a single client; Promise.all here only queued them and is deprecated by pg).
 */
export async function loadInsightFacts(db: Db, organizationId: string, siteFilter: string | null): Promise<InsightFacts> {
    const devices = await db.query<InsightFacts['devices'][number] & { site_id: string }>(
        `SELECT d.id, d.site_id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS label, host(d.current_ip) AS ip,
                d.status, d.trust, d.is_critical, d.mac_randomized,
                (d.display_name IS NOT NULL OR d.hostname IS NOT NULL) AS named,
                EXISTS (SELECT 1 FROM monitoring_checks c WHERE c.device_id = d.id) AS monitored,
                d.first_seen_at, d.last_seen_at
           FROM devices d
          WHERE ($1::uuid IS NULL OR d.site_id = $1)
          ORDER BY d.current_ip NULLS LAST`,
        [siteFilter],
    );
    const collectors = await db.query<InsightFacts['collectors'][number]>(
      `SELECT id, name, last_heartbeat_at, host(gateway_ip) AS gateway_ip
         FROM collectors
        WHERE status = 'active' AND ($1::uuid IS NULL OR site_id = $1)
        ORDER BY name`,
      [siteFilter],
    );
    const scopes = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM network_scopes WHERE enabled AND ($1::uuid IS NULL OR site_id = $1)`,
      [siteFilter],
    );
    const checks = await db.query<InsightFacts['checks'][number]>(
      `SELECT id, name, role, state, last_latency_ms, last_loss_pct, kind, last_error, last_value, last_details ->> 'cert_not_after' AS cert_not_after
         FROM monitoring_checks
        WHERE enabled AND ($1::uuid IS NULL OR site_id = $1)
        ORDER BY name`,
      [siteFilter],
    );
    const incidents = await db.query<InsightFacts['openIncidents'][number]>(
      `SELECT id, title, severity
         FROM incidents
        WHERE status <> 'resolved' AND ($1::uuid IS NULL OR site_id = $1)
        ORDER BY opened_at DESC LIMIT 20`,
      [siteFilter],
    );
    const conflicts = await db.query<{ ip: string; at: Date }>(
      `SELECT details->>'ip' AS ip, occurred_at AS at FROM network_events
        WHERE type = 'ip_mac_changed' AND occurred_at > now() - interval '24 hours'
          AND ($1::uuid IS NULL OR site_id = $1)
        ORDER BY occurred_at DESC LIMIT 50`,
      [siteFilter],
    );
    const site = (
      await db.query<{ enabled: boolean; site_id: string }>(
        `SELECT a.enabled, a.site_id FROM site_access a WHERE ($1::uuid IS NULL OR a.site_id = $1) ORDER BY a.enabled DESC LIMIT 1`,
        [siteFilter],
      )
    ).rows[0];
    let access: InsightFacts['access'];
    if (site) {
      const col = await db.query<{ status: { listening?: boolean; error?: string } | null; addrs: string[] }>(
          `SELECT access_status AS status,
                  coalesce((SELECT array_agg(a) FROM jsonb_array_elements(coalesce(interfaces, '[]'::jsonb)) i, jsonb_array_elements_text(i->'addresses') a), '{}') AS addrs
             FROM collectors WHERE site_id = $1 AND status = 'active' ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1`,
          [site.site_id],
      );
      const prot = await db.query<{ n: number }>(
          `SELECT count(DISTINCT device_id)::int AS n FROM dns_stats WHERE site_id = $1 AND device_id IS NOT NULL AND window_end > now() - interval '30 minutes'`,
          [site.site_id],
      );
      const blocked = await db.query<{ device_id: string; label: string; category: string; count: number }>(
          `SELECT s.device_id, coalesce(d.display_name, d.hostname, host(d.current_ip)) AS label, t->>'category' AS category, sum((t->>'blocked')::int)::int AS count
             FROM dns_stats s JOIN devices d ON d.id = s.device_id, jsonb_array_elements(s.top_domains) t
            WHERE s.site_id = $1 AND s.window_end > now() - interval '24 hours' AND (t->>'blocked')::int > 0 AND t->>'category' IN ('adult', 'encrypted_dns')
            GROUP BY 1, 2, 3`,
          [site.site_id],
      );
      const c = col.rows[0];
      const ip = c?.addrs.map((a) => a.split('/')[0]!).find((a) => /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a)) ?? null;
      access = {
        enabled: site.enabled,
        listening: c?.status ? Boolean(c.status.listening) : null,
        error: c?.status?.error ?? null,
        dns_server_ip: ip,
        protected_devices: prot.rows[0]?.n ?? 0,
        online_devices: devices.rows.filter((d) => d.site_id === site.site_id && d.status === 'online' && d.ip !== ip).length,
        blocked: blocked.rows,
      };
    } else {
      access = { enabled: false, listening: null, error: null, dns_server_ip: null, protected_devices: 0, online_devices: 0, blocked: [] };
    }
    const unreadable = await db.query<{ id: string; name: string; error: string | null }>(
      `SELECT id, coalesce(name, sys_name, host(host)) AS name, last_error AS error
         FROM snmp_targets
        WHERE enabled AND last_status = 'error' AND ($1::uuid IS NULL OR site_id = $1)
        ORDER BY host`,
      [siteFilter],
    );
    // More than a handful of new errors since the previous read (a few minutes): not a one-off.
    const erroring = await db.query<{ target_id: string; switch_name: string; port_name: string; errors: number; seconds: number }>(
        `SELECT t.id AS target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, p.name AS port_name, p.errors_delta::int AS errors, p.delta_seconds AS seconds
           FROM switch_ports p JOIN snmp_targets t ON t.id = p.target_id
          WHERE t.enabled AND t.last_status = 'ok' AND p.oper_up AND p.errors_delta >= 10 AND p.delta_seconds > 0 AND p.updated_at > now() - interval '1 hour'
            AND ($1::uuid IS NULL OR t.site_id = $1)
          ORDER BY p.errors_delta DESC LIMIT 10`,
        [siteFilter],
    );
    // Infrastructure Nigafiy classified itself (inferred, medium/high confidence) that nothing watches yet.
    // Only proposed where the site's `suggest.monitor_infrastructure` automation is on; nothing is created here.
    // Constant query count: the sites in scope, their settings in one batch, then one bounded read
    // (INFRASTRUCTURE_LIMIT rows, plus the exact total via count(*) OVER ()).
    const siteIds = (await db.query<{ id: string }>(`SELECT id FROM sites WHERE organization_id = $2 AND ($1::uuid IS NULL OR id = $1)`, [siteFilter, organizationId])).rows.map((r) => r.id);
    const settings = await automationSettingsForSites(db, organizationId, siteIds, 'suggest.monitor_infrastructure');
    const anyConfidence: string[] = [];
    const highOnly: string[] = [];
    for (const [siteId, setting] of settings) {
      if (!setting.enabled) continue;
      (setting.config.min_confidence === 'high' ? highOnly : anyConfidence).push(siteId);
    }
    let infrastructure: InfrastructureFact[] = [];
    let infrastructureTotal = 0;
    if (anyConfidence.length || highOnly.length) {
      const infraRows = (
        await db.query<InfrastructureFact & { total: number }>(
          `SELECT d.id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS label, host(d.current_ip) AS ip,
                  d.device_type, d.type_confidence, d.type_evidence, count(*) OVER ()::int AS total
             FROM devices d
            WHERE d.type_source = 'inferred' AND d.device_type = ANY($1) AND d.type_confidence IN ('medium', 'high')
              AND d.current_ip IS NOT NULL AND NOT EXISTS (SELECT 1 FROM monitoring_checks c WHERE c.device_id = d.id)
              AND (d.site_id = ANY($2::uuid[]) OR (d.site_id = ANY($3::uuid[]) AND d.type_confidence = 'high'))
            ORDER BY d.current_ip
            LIMIT $4`,
          [INFRASTRUCTURE_TYPES, anyConfidence, highOnly, INFRASTRUCTURE_LIMIT],
        )
      ).rows;
      infrastructureTotal = infraRows[0]?.total ?? 0;
      infrastructure = infraRows.map(({ total: _t, ...r }) => r);
    }
    // Unwanted devices online that a configured, reachable router could block (proposal only).
    const routerBlockable = (
      await db.query<{ device_id: string; router_id: string; router_name: string }>(
        `SELECT DISTINCT ON (d.id) d.id AS device_id, r.id AS router_id, r.name AS router_name
           FROM devices d JOIN site_routers r ON r.site_id = d.site_id
          WHERE d.trust = 'unwanted' AND d.status = 'online' AND d.primary_mac IS NOT NULL
            AND ($1::uuid IS NULL OR d.site_id = $1)
            AND r.enabled AND r.status = 'ok' AND r.login_paused_reason IS NULL
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(r.capabilities, '[]'::jsonb)) c WHERE c->>'capability' = 'block' AND (c->>'supported')::boolean)
            AND NOT EXISTS (SELECT 1 FROM router_blocks b WHERE b.router_id = r.id AND b.mac = d.primary_mac AND b.released_at IS NULL)
          ORDER BY d.id, r.name`,
        [siteFilter],
      )
    ).rows;
    return {
      routerBlockable,
      infrastructure,
      infrastructureTotal,
      ports: { unreadable: unreadable.rows, erroring: erroring.rows },
      access,
      now: new Date(),
      devices: devices.rows.map(({ site_id: _s, ...d }) => d),
      collectors: collectors.rows,
      scopes: scopes.rows[0]?.n ?? 0,
      checks: checks.rows,
      openIncidents: incidents.rows,
      ipConflicts: conflicts.rows,
    };
}
