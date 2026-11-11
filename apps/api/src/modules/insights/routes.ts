import { Router } from 'express';
import { auth } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { type InsightFacts, buildInsights } from './rules.ts';

export const insightsRouter: Router = Router();

insightsRouter.get('/insights', async (req, res) => {
  const ctx = auth(req);
  // One transaction = one connection: queries run one after another (pg cannot run them in parallel
  // on a single client; Promise.all here only queued them and is deprecated by pg).
  const facts = await withTenant(ctx.organizationId, async (db): Promise<InsightFacts> => {
    const devices = await db.query<InsightFacts['devices'][number]>(
        `SELECT d.id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS label, host(d.current_ip) AS ip,
                d.status, d.trust, d.is_critical, d.mac_randomized,
                (d.display_name IS NOT NULL OR d.hostname IS NOT NULL) AS named,
                EXISTS (SELECT 1 FROM monitoring_checks c WHERE c.device_id = d.id) AS monitored,
                d.first_seen_at, d.last_seen_at
           FROM devices d ORDER BY d.current_ip NULLS LAST`,
    );
    const collectors = await db.query<InsightFacts['collectors'][number]>(
      `SELECT id, name, last_heartbeat_at, host(gateway_ip) AS gateway_ip FROM collectors WHERE status = 'active' ORDER BY name`,
    );
    const scopes = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM network_scopes WHERE enabled`);
    const checks = await db.query<InsightFacts['checks'][number]>(
      `SELECT id, name, role, state, last_latency_ms, last_loss_pct FROM monitoring_checks WHERE enabled ORDER BY name`,
    );
    const incidents = await db.query<InsightFacts['openIncidents'][number]>(
      `SELECT id, title, severity FROM incidents WHERE status <> 'resolved' ORDER BY opened_at DESC LIMIT 20`,
    );
    const conflicts = await db.query<{ ip: string; at: Date }>(
      `SELECT details->>'ip' AS ip, occurred_at AS at FROM network_events
        WHERE type = 'ip_mac_changed' AND occurred_at > now() - interval '24 hours' ORDER BY occurred_at DESC LIMIT 50`,
    );
    const site = (
      await db.query<{ enabled: boolean; site_id: string }>(`SELECT a.enabled, a.site_id FROM site_access a ORDER BY a.enabled DESC LIMIT 1`)
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
        online_devices: devices.rows.filter((d) => d.status === 'online' && d.ip !== ip).length,
        blocked: blocked.rows,
      };
    } else {
      access = { enabled: false, listening: null, error: null, dns_server_ip: null, protected_devices: 0, online_devices: 0, blocked: [] };
    }
    const unreadable = await db.query<{ id: string; name: string; error: string | null }>(
      `SELECT id, coalesce(name, sys_name, host(host)) AS name, last_error AS error FROM snmp_targets WHERE enabled AND last_status = 'error' ORDER BY host`,
    );
    // More than a handful of new errors since the previous read (a few minutes): not a one-off.
    const erroring = await db.query<{ target_id: string; switch_name: string; port_name: string; errors: number; seconds: number }>(
        `SELECT t.id AS target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, p.name AS port_name, p.errors_delta::int AS errors, p.delta_seconds AS seconds
           FROM switch_ports p JOIN snmp_targets t ON t.id = p.target_id
          WHERE t.enabled AND t.last_status = 'ok' AND p.oper_up AND p.errors_delta >= 10 AND p.delta_seconds > 0 AND p.updated_at > now() - interval '1 hour'
          ORDER BY p.errors_delta DESC LIMIT 10`,
    );
    return {
      ports: { unreadable: unreadable.rows, erroring: erroring.rows },
      access,
      now: new Date(),
      devices: devices.rows,
      collectors: collectors.rows,
      scopes: scopes.rows[0]?.n ?? 0,
      checks: checks.rows,
      openIncidents: incidents.rows,
      ipConflicts: conflicts.rows,
    };
  });
  res.json(buildInsights(facts));
});
