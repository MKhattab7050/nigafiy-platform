import type { CollectorContext, SmartCheckItem } from '../../common/collector-protocol.ts';
import { normalizeMac } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';
import { automationEnabled } from '../automation/index.ts';
import { type Fingerprint, applyIdentification, classifyDhcp } from '../devices/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { recordClientChoices } from './dhcp.ts';

// Device identification from two smart checks: the web banner probe ('banners') and the DHCP option
// fingerprints the passive DHCP listener overheard ('dhcp_fingerprints'). Both only add evidence to
// the device's fingerprint; the devices module decides the type (a manual type is never changed).

type BannerResult = NonNullable<SmartCheckItem['banners']>['results'][number];

/** The most telling banner of one device: one with a page title or server name, TLS last. */
export function bestBanner(results: BannerResult[]): Record<string, string> {
  const hints: Record<string, string> = {};
  const sorted = [...results].sort((a, b) => Number(Boolean(b.title)) - Number(Boolean(a.title)) || a.port - b.port);
  for (const r of sorted) {
    if (r.title && !hints.http_title) hints.http_title = r.title;
    if (r.server && !hints.http_server) hints.http_server = r.server;
    if (r.tls_subject && !hints.tls_subject) hints.tls_subject = r.tls_subject;
    if (r.tls_issuer && !hints.tls_issuer) hints.tls_issuer = r.tls_issuer;
  }
  return hints;
}

export function summarizeBanners(block: SmartCheckItem['banners']): Record<string, unknown> {
  return { probed: block?.probed.length ?? 0, answered: new Set((block?.results ?? []).map((r) => r.ip)).size, results: block?.results.length ?? 0 };
}

export async function processBanners(db: Db, c: CollectorContext, item: SmartCheckItem): Promise<void> {
  const block = item.banners;
  if (!block) return;
  const at = new Date(item.ts);
  const devices = (
    await db.query<{ id: string; ip: string }>(
      `SELECT DISTINCT ON (current_ip) id, host(current_ip) AS ip FROM devices
        WHERE organization_id = $1 AND site_id = $2 AND current_ip = ANY($3::inet[]) ORDER BY current_ip, last_seen_at DESC`,
      [c.organizationId, c.siteId, block.probed],
    )
  ).rows;
  const byIp = new Map(devices.map((d) => [d.ip, d.id]));
  for (const d of devices) {
    await db.query(
      `INSERT INTO device_banner_probes (organization_id, device_id, last_probed_at) VALUES ($1,$2,$3)
       ON CONFLICT (organization_id, device_id) DO UPDATE SET last_probed_at = EXCLUDED.last_probed_at`,
      [c.organizationId, d.id, at],
    );
  }
  const perDevice = new Map<string, BannerResult[]>();
  for (const r of block.results) {
    const id = byIp.get(r.ip);
    if (!id) continue; // only devices of this site's inventory
    perDevice.set(id, [...(perDevice.get(id) ?? []), r]);
    await db.query(
      `INSERT INTO device_banners (organization_id, device_id, port, ip, scheme, status, title, server, tls_subject, tls_issuer, tls_self_signed, probed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (organization_id, device_id, port) DO UPDATE
          SET ip = EXCLUDED.ip, scheme = EXCLUDED.scheme, status = EXCLUDED.status, title = EXCLUDED.title, server = EXCLUDED.server,
              tls_subject = EXCLUDED.tls_subject, tls_issuer = EXCLUDED.tls_issuer, tls_self_signed = EXCLUDED.tls_self_signed, probed_at = EXCLUDED.probed_at`,
      [c.organizationId, id, r.port, r.ip, r.scheme, r.status ?? null, r.title ?? null, r.server ?? null, r.tls_subject ?? null, r.tls_issuer ?? null, r.tls_self_signed ?? null, at],
    );
  }
  // A port that no longer answered this time is forgotten for the probed devices.
  for (const d of devices) {
    const ports = (perDevice.get(d.id) ?? []).map((r) => r.port);
    await db.query(`DELETE FROM device_banners WHERE organization_id = $1 AND device_id = $2 AND NOT (port = ANY($3::int[]))`, [c.organizationId, d.id, ports]);
  }
  if (!perDevice.size) return;
  const seen = new Map<string, Fingerprint>();
  for (const [id, results] of perDevice) {
    const hints = bestBanner(results);
    if (Object.keys(hints).length) seen.set(id, { hints });
  }
  await applyIdentification(db, seen, { ip: c.gatewayIp, collector: c.name });
  await notifyRealtime(db, c.organizationId, 'devices');
}

export function summarizeFingerprints(block: SmartCheckItem['dhcp_fingerprints']): Record<string, unknown> {
  return { clients: block?.clients.length ?? 0 };
}

export async function processDhcpFingerprints(db: Db, c: CollectorContext, item: SmartCheckItem, now: Date): Promise<void> {
  const block = item.dhcp_fingerprints;
  if (!block?.clients.length) return;
  const classify = await automationEnabled(db, c.organizationId, c.siteId, 'smart.dhcp_fingerprint');
  const seen = new Map<string, Fingerprint>();
  const choices: { server_id: string; seen_at: Date }[] = [];
  for (const cl of block.clients) {
    const mac = normalizeMac(cl.mac);
    const os = classifyDhcp(cl.prl, cl.vendor_class);
    const seenAt = new Date(cl.seen_at);
    await db.query(
      `INSERT INTO dhcp_fingerprints (organization_id, site_id, mac, prl, vendor_class, hostname, server_id, os_family, confidence, seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (organization_id, site_id, mac) DO UPDATE
          SET prl = EXCLUDED.prl, vendor_class = EXCLUDED.vendor_class, hostname = coalesce(EXCLUDED.hostname, dhcp_fingerprints.hostname),
              server_id = coalesce(EXCLUDED.server_id, dhcp_fingerprints.server_id), os_family = EXCLUDED.os_family, confidence = EXCLUDED.confidence,
              seen_at = greatest(dhcp_fingerprints.seen_at, EXCLUDED.seen_at)`,
      [c.organizationId, c.siteId, mac, cl.prl, cl.vendor_class ?? null, cl.hostname ?? null, cl.server_id ?? null, os?.os_family ?? null, os?.confidence ?? null, seenAt],
    );
    if (cl.server_id) choices.push({ server_id: cl.server_id, seen_at: seenAt });
    if (classify) {
      const device = (
        await db.query<{ id: string }>(`SELECT id FROM devices WHERE organization_id = $1 AND site_id = $2 AND primary_mac = $3::macaddr`, [c.organizationId, c.siteId, mac])
      ).rows[0];
      if (device) seen.set(device.id, { hints: { dhcp_prl: cl.prl, ...(cl.vendor_class ? { dhcp_vendor_class: cl.vendor_class } : {}) } });
    }
  }
  // Clients overheard choosing a DHCP server (option 54) are evidence for the rogue-DHCP check.
  await recordClientChoices(db, c, choices, now);
  if (seen.size) {
    await applyIdentification(db, seen, { ip: c.gatewayIp, collector: c.name });
    await notifyRealtime(db, c.organizationId, 'devices');
  }
}
