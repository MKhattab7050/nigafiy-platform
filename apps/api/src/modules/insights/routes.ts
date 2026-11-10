import { Router } from 'express';
import { auth } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { type InsightFacts, buildInsights } from './rules.ts';

export const insightsRouter: Router = Router();

insightsRouter.get('/insights', async (req, res) => {
  const ctx = auth(req);
  const facts = await withTenant(ctx.organizationId, async (db): Promise<InsightFacts> => {
    const [devices, collectors, scopes, checks, incidents, conflicts] = await Promise.all([
      db.query<InsightFacts['devices'][number]>(
        `SELECT d.id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS label, host(d.current_ip) AS ip,
                d.status, d.trust, d.is_critical, d.mac_randomized,
                (d.display_name IS NOT NULL OR d.hostname IS NOT NULL) AS named,
                EXISTS (SELECT 1 FROM monitoring_checks c WHERE c.device_id = d.id) AS monitored,
                d.first_seen_at, d.last_seen_at
           FROM devices d ORDER BY d.current_ip NULLS LAST`,
      ),
      db.query<InsightFacts['collectors'][number]>(
        `SELECT id, name, last_heartbeat_at, host(gateway_ip) AS gateway_ip FROM collectors WHERE status = 'active' ORDER BY name`,
      ),
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM network_scopes WHERE enabled`),
      db.query<InsightFacts['checks'][number]>(
        `SELECT id, name, role, state, last_latency_ms, last_loss_pct FROM monitoring_checks WHERE enabled ORDER BY name`,
      ),
      db.query<InsightFacts['openIncidents'][number]>(`SELECT id, title, severity FROM incidents WHERE status <> 'resolved' ORDER BY opened_at DESC LIMIT 20`),
      db.query<{ ip: string; at: Date }>(
        `SELECT details->>'ip' AS ip, occurred_at AS at FROM network_events
          WHERE type = 'ip_mac_changed' AND occurred_at > now() - interval '24 hours' ORDER BY occurred_at DESC LIMIT 50`,
      ),
    ]);
    const site = (
      await db.query<{ enabled: boolean; site_id: string }>(`SELECT a.enabled, a.site_id FROM site_access a ORDER BY a.enabled DESC LIMIT 1`)
    ).rows[0];
    let access: InsightFacts['access'];
    if (site) {
      const [col, prot, blocked] = await Promise.all([
        db.query<{ status: { listening?: boolean; error?: string } | null; addrs: string[] }>(
          `SELECT access_status AS status,
                  coalesce((SELECT array_agg(a) FROM jsonb_array_elements(coalesce(interfaces, '[]'::jsonb)) i, jsonb_array_elements_text(i->'addresses') a), '{}') AS addrs
             FROM collectors WHERE site_id = $1 AND status = 'active' ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1`,
          [site.site_id],
        ),
        db.query<{ n: number }>(
          `SELECT count(DISTINCT device_id)::int AS n FROM dns_stats WHERE site_id = $1 AND device_id IS NOT NULL AND window_end > now() - interval '30 minutes'`,
          [site.site_id],
        ),
        db.query<{ device_id: string; label: string; category: string; count: number }>(
          `SELECT s.device_id, coalesce(d.display_name, d.hostname, host(d.current_ip)) AS label, t->>'category' AS category, sum((t->>'blocked')::int)::int AS count
             FROM dns_stats s JOIN devices d ON d.id = s.device_id, jsonb_array_elements(s.top_domains) t
            WHERE s.site_id = $1 AND s.window_end > now() - interval '24 hours' AND (t->>'blocked')::int > 0 AND t->>'category' IN ('adult', 'encrypted_dns')
            GROUP BY 1, 2, 3`,
          [site.site_id],
        ),
      ]);
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
    return {
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
