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
    return {
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
