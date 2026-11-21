import type { CollectorContext, SmartCheckItem } from '../../common/collector-protocol.ts';
import type { Db } from '../../infrastructure/db.ts';
import { emitEvent } from '../events/index.ts';
import { approvedValues } from './dhcp.ts';
import { type FindingInput, syncFindings } from './findings.ts';
import { mappingKey, mappingRisk } from './upnp-risk.ts';

// UPnP IGD exposure audit (check 'upnp'): the port forwards the site's gateway opened through UPnP,
// read with GetGenericPortMappingEntry by the collector. Read only — nothing is ever added or removed.

export function summarizeUpnp(block: SmartCheckItem['upnp']): Record<string, unknown> {
  const gws = block?.gateways ?? [];
  return { gateways: gws.length, mappings: gws.reduce((n, g) => n + g.mappings.length, 0), errors: gws.filter((g) => g.error).map((g) => `${g.address}: ${g.error}`) };
}

async function deviceByIp(db: Db, organizationId: string, siteId: string, ip: string): Promise<{ id: string; device_type: string; name: string } | null> {
  return (
    (
      await db.query<{ id: string; device_type: string; name: string }>(
        `SELECT id, device_type, coalesce(display_name, hostname, host(current_ip)) AS name FROM devices
          WHERE organization_id = $1 AND site_id = $2 AND current_ip = $3::inet ORDER BY last_seen_at DESC LIMIT 1`,
        [organizationId, siteId, ip],
      )
    ).rows[0] ?? null
  );
}

export async function processUpnpAudit(db: Db, c: CollectorContext, item: SmartCheckItem, now: Date): Promise<void> {
  const block = item.upnp;
  if (!block) return;
  const at = new Date(item.ts);
  const approved = await approvedValues(db, c.organizationId, c.siteId, 'upnp_mapping');
  // Gateways this collector reported before: a gateway that no longer answers has its findings resolved.
  const previous = await db.query<{ address: string }>(
    `SELECT host(address) AS address FROM upnp_gateways WHERE organization_id = $1 AND site_id = $2 AND collector_id = $3`,
    [c.organizationId, c.siteId, c.id],
  );
  const covered = new Set([...previous.rows.map((r) => r.address), ...block.gateways.map((g) => g.address)]);
  const findings: FindingInput[] = [];

  for (const gw of block.gateways) {
    const gwDevice = await deviceByIp(db, c.organizationId, c.siteId, gw.address);
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO upnp_gateways (organization_id, site_id, collector_id, address, device_id, friendly_name, manufacturer, model, service_type, external_ip, mappings_truncated, last_error, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         ON CONFLICT (organization_id, site_id, address) DO UPDATE
            SET collector_id = EXCLUDED.collector_id, device_id = EXCLUDED.device_id, friendly_name = EXCLUDED.friendly_name, manufacturer = EXCLUDED.manufacturer,
                model = EXCLUDED.model, service_type = EXCLUDED.service_type, external_ip = EXCLUDED.external_ip,
                mappings_truncated = EXCLUDED.mappings_truncated, last_error = EXCLUDED.last_error, last_seen_at = EXCLUDED.last_seen_at
         RETURNING id`,
        [
          c.organizationId,
          c.siteId,
          c.id,
          gw.address,
          gwDevice?.id ?? null,
          gw.friendly_name ?? null,
          gw.manufacturer ?? null,
          gw.model ?? null,
          gw.service_type ?? null,
          gw.external_ip ?? null,
          gw.mappings_truncated,
          gw.error ?? null,
          at,
        ],
      )
    ).rows[0]!;
    const gwName = gw.friendly_name ?? gw.model ?? gw.address;
    findings.push({
      kind: 'upnp_igd_enabled',
      key: `${gw.address}|igd`,
      severity: 'info',
      title: `UPnP port forwarding is enabled on ${gwName} (${gw.address})`,
      details: {
        gateway: gw.address,
        friendly_name: gw.friendly_name ?? null,
        manufacturer: gw.manufacturer ?? null,
        model: gw.model ?? null,
        external_ip: gw.external_ip ?? null,
        mappings: gw.mappings.length,
        basis: 'observed: the gateway answered UPnP IGD discovery and its port-mapping service',
        why: 'Any program on any device of the network can open ports to the internet without asking. Turn UPnP off on the router unless something needs it.',
      },
      deviceId: gwDevice?.id ?? null,
    });

    if (gw.error && gw.mappings.length === 0) continue; // the list could not be read: keep the last known mappings
    const keep: string[] = [];
    for (const m of gw.mappings) {
      const dev = await deviceByIp(db, c.organizationId, c.siteId, m.internal_client);
      const risk = mappingRisk({ protocol: m.protocol, external_port: m.external_port, internal_port: m.internal_port, description: m.description ?? null, device_type: dev?.device_type ?? null });
      const key = mappingKey(gw.address, m);
      const saved = await db.query<{ id: string }>(
        `INSERT INTO upnp_mappings (organization_id, site_id, gateway_id, protocol, external_port, remote_host, internal_client, internal_port, description, enabled, lease_seconds, device_id, risk, risk_reason, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
         ON CONFLICT (gateway_id, protocol, external_port, remote_host) DO UPDATE
            SET internal_client = EXCLUDED.internal_client, internal_port = EXCLUDED.internal_port, description = EXCLUDED.description, enabled = EXCLUDED.enabled,
                lease_seconds = EXCLUDED.lease_seconds, device_id = EXCLUDED.device_id, risk = EXCLUDED.risk, risk_reason = EXCLUDED.risk_reason, last_seen_at = EXCLUDED.last_seen_at
         RETURNING id`,
        [
          c.organizationId,
          c.siteId,
          row.id,
          m.protocol,
          m.external_port,
          m.remote_host,
          m.internal_client,
          m.internal_port,
          m.description ?? null,
          m.enabled,
          m.lease_seconds ?? null,
          dev?.id ?? null,
          risk.risk,
          risk.reason,
          at,
        ],
      );
      keep.push(saved.rows[0]!.id);
      if (risk.risk !== 'info' && m.enabled && !approved.has(key.toLowerCase())) {
        findings.push({
          kind: 'upnp_risky_mapping',
          key,
          severity: risk.risk,
          title: `${risk.service ?? 'A service'} of ${dev?.name ?? m.internal_client} is open to the internet (${m.protocol} ${m.external_port})`,
          details: {
            gateway: gw.address,
            external_ip: gw.external_ip ?? null,
            protocol: m.protocol,
            external_port: m.external_port,
            internal_client: m.internal_client,
            internal_port: m.internal_port,
            description: m.description ?? null,
            lease_seconds: m.lease_seconds ?? null,
            service: risk.service,
            reason: risk.reason,
            device_type: dev?.device_type ?? null,
            basis: 'observed: port mapping listed by the gateway (GetGenericPortMappingEntry)',
            confidence: 'high',
          },
          deviceId: dev?.id ?? null,
        });
      }
    }
    await db.query(`DELETE FROM upnp_mappings WHERE organization_id = $1 AND gateway_id = $2 AND NOT (id = ANY($3::uuid[]))`, [c.organizationId, row.id, keep]);
  }

  const opened = await syncFindings(db, c.organizationId, c.siteId, 'upnp', findings, now, {
    keyPrefixes: [...covered].map((a) => `${a}|`),
    resolution: 'No longer listed by the gateway',
  });
  for (const f of opened) {
    if (f.kind !== 'upnp_risky_mapping') continue;
    await emitEvent(db, c.organizationId, {
      siteId: c.siteId,
      deviceId: f.deviceId ?? null,
      collectorId: c.id,
      type: 'upnp_risky_mapping',
      severity: f.severity,
      title: f.title,
      details: f.details,
      source: 'collector',
      occurredAt: at,
    });
  }
}
