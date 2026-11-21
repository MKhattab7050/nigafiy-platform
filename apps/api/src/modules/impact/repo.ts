import { notFound } from '../../common/http.ts';
import type { Db } from '../../infrastructure/db.ts';
import { buildTopology } from '../topology/index.ts';
import { type CheckFact, type CollectorFact, type EndpointFact, type Twin, type WirelessFact, buildTwin } from './graph.ts';

/**
 * Loads one site's digital twin inside the caller's tenant transaction (RLS applies to every query).
 * The network graph itself comes from the topology module; only the facts topology does not carry
 * (collectors as nodes, checks, managed computers, Wi-Fi associations) are read here.
 */
export async function loadTwin(db: Db, siteId: string): Promise<Twin> {
  const site = (await db.query<{ id: string; name: string }>(`SELECT id, name FROM sites WHERE id = $1`, [siteId])).rows[0];
  if (!site) throw notFound('Site');
  const topology = await buildTopology(db, siteId);
  const collectors = await db.query<CollectorFact>(
    `SELECT id, name, connection_state, interfaces FROM collectors WHERE site_id = $1 AND status = 'active' ORDER BY name`,
    [siteId],
  );
  const checks = await db.query<CheckFact>(
    `SELECT id, name, kind, role, target, device_id, last_resolved_target, state
       FROM monitoring_checks WHERE site_id = $1 AND enabled ORDER BY name`,
    [siteId],
  );
  const endpoints = await db.query<EndpointFact>(`SELECT id, name, device_id FROM endpoints WHERE site_id = $1 AND status = 'active' ORDER BY name`, [siteId]);
  // Wi-Fi associations a configured router reported in the last day (wired clients are left to the switches).
  const wireless = await db.query<WirelessFact>(
    `SELECT r.name AS router_name, r.device_id AS router_device_id, c.device_id AS client_device_id, c.connection, c.interface, c.last_seen_at, c.active
       FROM router_clients c JOIN site_routers r ON r.id = c.router_id
      WHERE c.site_id = $1 AND r.enabled AND r.device_id IS NOT NULL AND c.device_id IS NOT NULL
        AND c.connection ILIKE 'wifi%' AND c.last_seen_at > now() - interval '1 day'`,
    [siteId],
  );
  return buildTwin({
    siteId,
    siteName: site.name,
    topology,
    collectors: collectors.rows,
    checks: checks.rows,
    endpoints: endpoints.rows,
    wireless: wireless.rows,
  });
}
