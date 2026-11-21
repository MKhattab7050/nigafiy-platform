import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { isIPv4, normalizeMac } from '../../common/net.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { CHECK_AUTOMATION, RUNNABLE_CHECKS, buildSmartCheckConfig } from './config.ts';
import { evaluateDhcpSite } from './dhcp.ts';

/**
 * Smart network checks (Phase 5):
 *   GET    /security                       everything measured for one site (runs, DHCP, UPnP, Wi-Fi, fingerprints, schedule)
 *   GET    /security/findings              findings (open by default), newest first
 *   POST   /security/findings/:id/acknowledge   technician — "I have seen this"
 *   POST   /security/findings/:id/resolve       technician — closes it until it is observed again
 *   POST   /security/findings/:id/expected      admin — "this is expected": approve the server / BSSID / mapping it is about
 *   POST   /security/expected              admin — approve a DHCP server, Wi-Fi BSSID or UPnP mapping directly
 *   DELETE /security/expected/:id          admin — withdraw an approval
 *   POST   /security/run                   technician — ask the site's collectors to run checks now
 *   GET    /security/schedule              effective schedule per check (edited through PUT /automation/:key)
 */
export const securityRouter: Router = Router();

const siteQuery = z.object({ site_id: z.uuid() });
const MAC = /^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/;
const MAPPING = /^(\d{1,3}\.){3}\d{1,3}\|(TCP|UDP)\|\d{1,5}\|(\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;

async function assertSite(db: Db, siteId: string): Promise<void> {
  if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
}

const FINDING_SELECT = `
  SELECT f.id, f.site_id, f.category, f.kind, f.key, f.severity, f.title, f.details, f.device_id,
         coalesce(d.display_name, d.hostname, host(d.current_ip)) AS device_name,
         f.status, f.first_seen_at, f.last_seen_at, f.resolved_at, f.resolution, f.acknowledged_at, f.acknowledged_by
    FROM security_findings f
    LEFT JOIN devices d ON d.organization_id = f.organization_id AND d.id = f.device_id`;

// ── overview ──

securityRouter.get('/security', async (req, res) => {
  const ctx = auth(req);
  const { site_id: siteId } = parse(siteQuery, req.query);
  const body = await withTenant(ctx.organizationId, async (db) => {
    await assertSite(db, siteId);
    const collectors = await db.query<{ id: string; name: string; os: string | null; online: boolean }>(
      `SELECT id, name, os, connection_state = 'online' AS online FROM collectors WHERE site_id = $1 AND status = 'active' ORDER BY name`,
      [siteId],
    );
    const runs = await db.query(
      `SELECT r.collector_id, c.name AS collector_name, r.check_kind, r.trigger, r.ok, r.error_kind, r.error, r.duration_ms, r.summary, r.ran_at
         FROM smart_check_runs r JOIN collectors c ON c.organization_id = r.organization_id AND c.id = r.collector_id
        WHERE r.site_id = $1 ORDER BY r.check_kind, c.name`,
      [siteId],
    );
    const requests = await db.query(`SELECT check_kind, requested_at FROM smart_check_requests WHERE site_id = $1 ORDER BY check_kind`, [siteId]);
    const findings = await db.query(`${FINDING_SELECT} WHERE f.site_id = $1 AND f.status = 'open' ORDER BY array_position(ARRAY['critical','warning','info'], f.severity), f.last_seen_at DESC`, [siteId]);
    const dhcpServers = await db.query(
      `SELECT id, host(server_id) AS server_id, host(source_ip) AS source_ip, server_mac::text AS server_mac, host(offered_ip) AS offered_ip,
              host(subnet_mask) AS subnet_mask, ARRAY(SELECT host(r) FROM unnest(routers) r) AS routers, ARRAY(SELECT host(d) FROM unnest(dns_servers) d) AS dns_servers,
              lease_seconds, domain, interfaces, expected, first_seen_at, last_offer_at, missed_probes, rogue_open, clients_choosing, last_client_choice_at,
              (SELECT e.id FROM security_expected e WHERE e.organization_id = s.organization_id AND e.site_id = s.site_id AND e.kind = 'dhcp_server'
                  AND (e.value = host(s.server_id) OR e.value = s.server_mac::text) LIMIT 1) AS approval_id
         FROM dhcp_servers s WHERE site_id = $1 ORDER BY (expected IS NULL) DESC, server_id`,
      [siteId],
    );
    const probe = (await db.query(`SELECT probes, last_probe_at, consecutive_no_offer, no_offer_open FROM dhcp_probe_state WHERE site_id = $1`, [siteId])).rows[0] ?? null;
    const gateways = await db.query(
      `SELECT g.id, host(g.address) AS address, g.friendly_name, g.manufacturer, g.model, g.service_type, host(g.external_ip) AS external_ip,
              g.mappings_truncated, g.last_error, g.first_seen_at, g.last_seen_at, c.name AS collector_name,
              coalesce((SELECT json_agg(json_build_object(
                   'id', m.id, 'protocol', m.protocol, 'external_port', m.external_port, 'remote_host', m.remote_host,
                   'internal_client', host(m.internal_client), 'internal_port', m.internal_port, 'description', m.description, 'enabled', m.enabled,
                   'lease_seconds', m.lease_seconds, 'device_id', m.device_id, 'device_name', coalesce(d.display_name, d.hostname),
                   'risk', m.risk, 'risk_reason', m.risk_reason, 'first_seen_at', m.first_seen_at, 'last_seen_at', m.last_seen_at)
                 ORDER BY array_position(ARRAY['critical','warning','info'], m.risk), m.external_port)
                 FROM upnp_mappings m LEFT JOIN devices d ON d.organization_id = m.organization_id AND d.id = m.device_id
                WHERE m.gateway_id = g.id), '[]') AS mappings
         FROM upnp_gateways g LEFT JOIN collectors c ON c.organization_id = g.organization_id AND c.id = g.collector_id
        WHERE g.site_id = $1 ORDER BY g.address`,
      [siteId],
    );
    const wifi = await db.query(
      `SELECT w.collector_id, c.name AS collector_name, w.platform, w.interface, w.connected, w.ssid, w.bssid::text AS bssid, w.band, w.channel, w.frequency_mhz,
              w.signal_pct, w.rssi_dbm, w.rx_mbps, w.tx_mbps, w.security, w.auth, w.cipher, w.phy, w.analysis, w.observed_at,
              coalesce((SELECT json_agg(json_build_object('bssid', n.bssid::text, 'ssid', n.ssid, 'channel', n.channel, 'band', n.band, 'frequency_mhz', n.frequency_mhz,
                   'signal_pct', n.signal_pct, 'rssi_dbm', n.rssi_dbm, 'security', n.security, 'auth', n.auth, 'cipher', n.cipher, 'last_seen_at', n.last_seen_at)
                 ORDER BY n.signal_pct DESC NULLS LAST, n.bssid)
                 FROM wifi_networks n WHERE n.organization_id = w.organization_id AND n.collector_id = w.collector_id), '[]') AS networks,
              coalesce((SELECT json_agg(json_build_object('ts', s.ts, 'signal_pct', s.signal_pct, 'rssi_dbm', s.rssi_dbm, 'rx_mbps', s.rx_mbps, 'tx_mbps', s.tx_mbps) ORDER BY s.ts)
                 FROM wifi_link_samples s WHERE s.organization_id = w.organization_id AND s.collector_id = w.collector_id AND s.ts > now() - interval '1 day'), '[]') AS samples
         FROM wifi_links w JOIN collectors c ON c.organization_id = w.organization_id AND c.id = w.collector_id
        WHERE w.site_id = $1 ORDER BY c.name`,
      [siteId],
    );
    const fingerprints = await db.query(
      `SELECT f.mac::text AS mac, f.prl, f.vendor_class, f.hostname, host(f.server_id) AS server_id, f.os_family, f.confidence, f.seen_at,
              d.id AS device_id, coalesce(d.display_name, d.hostname, host(d.current_ip)) AS device_name
         FROM dhcp_fingerprints f LEFT JOIN devices d ON d.organization_id = f.organization_id AND d.site_id = f.site_id AND d.primary_mac = f.mac
        WHERE f.site_id = $1 ORDER BY f.seen_at DESC LIMIT 300`,
      [siteId],
    );
    const banners = await db.query(
      `SELECT b.device_id, coalesce(d.display_name, d.hostname, host(d.current_ip)) AS device_name, b.port, host(b.ip) AS ip, b.scheme, b.status, b.title, b.server,
              b.tls_subject, b.tls_issuer, b.tls_self_signed, b.probed_at, d.device_type, d.type_source
         FROM device_banners b JOIN devices d ON d.organization_id = b.organization_id AND d.id = b.device_id
        WHERE d.site_id = $1 ORDER BY b.probed_at DESC, b.ip, b.port LIMIT 300`,
      [siteId],
    );
    const expected = await db.query(
      `SELECT e.id, e.kind, e.value, e.note, e.created_at, e.created_by FROM security_expected e WHERE e.site_id = $1 ORDER BY e.kind, e.value`,
      [siteId],
    );
    const schedule = await buildSmartCheckConfig(db, ctx.organizationId, siteId);
    return {
      site_id: siteId,
      collectors: collectors.rows,
      runs: runs.rows,
      requests: requests.rows,
      findings: findings.rows,
      dhcp: { servers: dhcpServers.rows, probe },
      upnp: { gateways: gateways.rows },
      wifi: wifi.rows,
      fingerprints: fingerprints.rows,
      banners: banners.rows,
      expected: expected.rows,
      schedule: {
        rogue_dhcp: { ...schedule.rogue_dhcp, automation_key: CHECK_AUTOMATION.rogue_dhcp },
        upnp: { ...schedule.upnp, automation_key: CHECK_AUTOMATION.upnp },
        wifi: { ...schedule.wifi, automation_key: CHECK_AUTOMATION.wifi },
        banners: { enabled: schedule.banners.enabled, interval_seconds: schedule.banners.interval_seconds, ports: schedule.banners.ports, due_devices: schedule.banners.targets.length, automation_key: CHECK_AUTOMATION.banners },
        dhcp_fingerprints: { ...schedule.dhcp_fingerprints, automation_key: CHECK_AUTOMATION.dhcp_fingerprints },
      },
    };
  });
  res.json(body);
});

// ── findings ──

securityRouter.get('/security/findings', async (req, res) => {
  const ctx = auth(req);
  const q = parse(
    z.object({
      site_id: z.uuid().optional(),
      status: z.enum(['open', 'resolved', 'all']).default('open'),
      category: z.enum(['dhcp', 'upnp', 'wifi']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
    req.query,
  );
  const items = await withTenant(ctx.organizationId, async (db) =>
    (
      await db.query(
        `${FINDING_SELECT}
          WHERE ($1::uuid IS NULL OR f.site_id = $1) AND ($2 = 'all' OR f.status = $2) AND ($3::text IS NULL OR f.category = $3)
          ORDER BY f.status, array_position(ARRAY['critical','warning','info'], f.severity), f.last_seen_at DESC
          LIMIT $4`,
        [q.site_id ?? null, q.status, q.category ?? null, q.limit],
      )
    ).rows,
  );
  res.json({ items });
});

interface FindingRow {
  id: string;
  site_id: string;
  category: 'dhcp' | 'upnp' | 'wifi';
  kind: string;
  key: string;
  status: 'open' | 'resolved';
  title: string;
  details: Record<string, unknown>;
}

async function loadFinding(db: Db, id: string): Promise<FindingRow> {
  const row = (await db.query<FindingRow>(`SELECT id, site_id, category, kind, key, status, title, details FROM security_findings WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!row) throw notFound('Finding');
  return row;
}

securityRouter.post('/security/findings/:id/acknowledge', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const f = await loadFinding(db, id);
    if (f.status !== 'open') throw new AppError(409, 'not_open', 'Only an open finding can be acknowledged');
    await db.query(`UPDATE security_findings SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1`, [id, ctx.userId]);
    await audit(db, req, 'security.finding_acknowledge', { type: 'security_finding', id }, { site_id: f.site_id, kind: f.kind, key: f.key, title: f.title });
    await notifyRealtime(db, ctx.organizationId, 'checks');
  });
  res.json({ ok: true });
});

securityRouter.post('/security/findings/:id/resolve', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ note: z.string().trim().max(300).optional() }).strict(), req.body ?? {});
  await withTenant(ctx.organizationId, async (db) => {
    const f = await loadFinding(db, id);
    if (f.status !== 'open') throw new AppError(409, 'not_open', 'This finding is already resolved');
    const resolution = `Resolved by ${ctx.userEmail}${body.note ? `: ${body.note}` : ''}. It re-opens if it is observed again.`;
    await db.query(`UPDATE security_findings SET status = 'resolved', resolved_at = now(), resolution = $2 WHERE id = $1`, [id, resolution]);
    await audit(db, req, 'security.finding_resolve', { type: 'security_finding', id }, { site_id: f.site_id, kind: f.kind, key: f.key, title: f.title, note: body.note ?? null });
    await notifyRealtime(db, ctx.organizationId, 'checks');
  });
  res.json({ ok: true });
});

// ── "this is expected" ──

type ExpectedKind = 'dhcp_server' | 'wifi_bssid' | 'upnp_mapping';

function normalizeExpected(kind: ExpectedKind, raw: string): string {
  const v = raw.trim();
  if (kind === 'dhcp_server') {
    if (isIPv4(v)) return v;
    if (MAC.test(v)) return normalizeMac(v);
    throw new AppError(400, 'invalid_value', 'A DHCP server is identified by its IPv4 address or its MAC address');
  }
  if (kind === 'wifi_bssid') {
    if (MAC.test(v)) return normalizeMac(v);
    throw new AppError(400, 'invalid_value', 'A Wi-Fi access point is identified by its BSSID (a MAC address)');
  }
  if (MAPPING.test(v)) return v;
  throw new AppError(400, 'invalid_value', 'A UPnP mapping is identified as gateway|protocol|external port|internal address:port');
}

/** Record the approval and apply it right away (DHCP re-evaluation, matching findings resolved). Returns the approval id. */
async function approve(db: Db, req: Parameters<typeof audit>[1], organizationId: string, userId: string, siteId: string, kind: ExpectedKind, value: string, note: string | null): Promise<string> {
  const row = (
    await db.query<{ id: string }>(
      `INSERT INTO security_expected (organization_id, site_id, kind, value, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_id, site_id, kind, value) DO UPDATE SET note = coalesce(EXCLUDED.note, security_expected.note)
       RETURNING id`,
      [organizationId, siteId, kind, value, note, userId],
    )
  ).rows[0]!;
  const now = new Date();
  const resolution = 'Marked as expected by an administrator';
  if (kind === 'dhcp_server') {
    await evaluateDhcpSite(db, organizationId, siteId, now, { collectorId: null, collectorName: null, at: now });
  } else if (kind === 'wifi_bssid') {
    await db.query(
      `UPDATE security_findings SET status = 'resolved', resolved_at = $3, resolution = $4
        WHERE site_id = $1 AND kind = 'wifi_evil_twin' AND status = 'open' AND split_part(key, '|', 2) = $2`,
      [siteId, value, now, resolution],
    );
  } else {
    await db.query(
      `UPDATE security_findings SET status = 'resolved', resolved_at = $3, resolution = $4 WHERE site_id = $1 AND kind = 'upnp_risky_mapping' AND status = 'open' AND lower(key) = lower($2)`,
      [siteId, value, now, resolution],
    );
  }
  await audit(db, req, 'security.expected_add', { type: 'security_expected', id: row.id }, { site_id: siteId, kind, value, note });
  await notifyRealtime(db, organizationId, 'checks');
  return row.id;
}

const expectedBody = z
  .object({
    site_id: z.uuid(),
    kind: z.enum(['dhcp_server', 'wifi_bssid', 'upnp_mapping']),
    value: z.string().min(1).max(120),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

securityRouter.post('/security/expected', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(expectedBody, req.body);
  const value = normalizeExpected(body.kind, body.value);
  const id = await withTenant(ctx.organizationId, async (db) => {
    await assertSite(db, body.site_id);
    return approve(db, req, ctx.organizationId, ctx.userId, body.site_id, body.kind, value, body.note || null);
  });
  res.status(201).json({ id, kind: body.kind, value });
});

/** What "this is expected" approves for a finding, or null when the finding is not about one thing that can be approved. */
export function expectedForFinding(f: Pick<FindingRow, 'kind' | 'key' | 'details'>): { kind: ExpectedKind; value: string } | null {
  if (f.kind === 'dhcp_rogue_server') return { kind: 'dhcp_server', value: f.key };
  if (f.kind === 'wifi_evil_twin') {
    const bssid = f.key.split('|')[1];
    return bssid ? { kind: 'wifi_bssid', value: bssid } : null;
  }
  if (f.kind === 'upnp_risky_mapping') return { kind: 'upnp_mapping', value: f.key };
  return null;
}

securityRouter.post('/security/findings/:id/expected', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(z.object({ note: z.string().trim().max(200).optional() }).strict(), req.body ?? {});
  const result = await withTenant(ctx.organizationId, async (db) => {
    const f = await loadFinding(db, id);
    const target = expectedForFinding(f);
    if (!target) throw new AppError(409, 'not_approvable', 'This finding is not about a server, access point or port forward that can be marked as expected');
    const value = normalizeExpected(target.kind, target.value);
    return { id: await approve(db, req, ctx.organizationId, ctx.userId, f.site_id, target.kind, value, body.note || null), kind: target.kind, value };
  });
  res.status(201).json(result);
});

securityRouter.delete('/security/expected/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const row = (await db.query<{ site_id: string; kind: ExpectedKind; value: string }>(`DELETE FROM security_expected WHERE id = $1 RETURNING site_id, kind, value`, [id])).rows[0];
    if (!row) throw notFound('Approval');
    if (row.kind === 'dhcp_server') {
      const now = new Date();
      await evaluateDhcpSite(db, ctx.organizationId, row.site_id, now, { collectorId: null, collectorName: null, at: now });
    }
    await audit(db, req, 'security.expected_remove', { type: 'security_expected', id }, { site_id: row.site_id, kind: row.kind, value: row.value });
    await notifyRealtime(db, ctx.organizationId, 'checks');
  });
  res.json({ ok: true });
});

// ── run now / schedule ──

securityRouter.post('/security/run', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(z.object({ site_id: z.uuid(), checks: z.array(z.enum(RUNNABLE_CHECKS)).min(1).max(RUNNABLE_CHECKS.length) }).strict(), req.body);
  const checks = [...new Set(body.checks)];
  const out = await withTenant(ctx.organizationId, async (db) => {
    await assertSite(db, body.site_id);
    const online = await db.query<{ name: string }>(
      `SELECT name FROM collectors WHERE site_id = $1 AND status = 'active' AND connection_state = 'online' ORDER BY name`,
      [body.site_id],
    );
    if (!online.rowCount) throw new AppError(409, 'no_collector_online', 'No collector at this site is currently reporting, so nothing can be checked');
    const now = new Date();
    for (const check of checks) {
      await db.query(
        `INSERT INTO smart_check_requests (organization_id, site_id, check_kind, requested_at, requested_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (organization_id, site_id, check_kind) DO UPDATE SET requested_at = EXCLUDED.requested_at, requested_by = EXCLUDED.requested_by`,
        [ctx.organizationId, body.site_id, check, now, ctx.userId],
      );
    }
    await audit(db, req, 'security.run_now', { type: 'site', id: body.site_id }, { checks });
    await notifyRealtime(db, ctx.organizationId, 'checks');
    return { checks, collectors: online.rows.map((r) => r.name), requested_at: now.toISOString() };
  });
  res.status(202).json(out);
});

securityRouter.get('/security/schedule', async (req, res) => {
  const ctx = auth(req);
  const { site_id: siteId } = parse(siteQuery, req.query);
  const schedule = await withTenant(ctx.organizationId, async (db) => {
    await assertSite(db, siteId);
    const cfg = await buildSmartCheckConfig(db, ctx.organizationId, siteId);
    return (['rogue_dhcp', 'upnp', 'wifi', 'banners', 'dhcp_fingerprints'] as const).map((check) => ({
      check,
      automation_key: CHECK_AUTOMATION[check],
      enabled: cfg[check].enabled,
      interval_seconds: cfg[check].interval_seconds,
    }));
  });
  res.json({ site_id: siteId, items: schedule });
});
