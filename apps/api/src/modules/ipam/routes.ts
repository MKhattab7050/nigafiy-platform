import { Router } from 'express';
import { z } from 'zod';
import type { IpamConflict, IpamHistoryEntry, IpamRecord, IpamSubnetDetail, IpamSubnetSummary } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { cidrContains, isIPv4, normalizeMac } from '../../common/net.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { emitEvent, notifyRealtime } from '../events/emit.ts';
import { type ObservedDevice, buildPlan, csvCell, intToIp, ipToInt, subnetMath } from './plan.ts';

export const ipamRouter: Router = Router();

// ── loading ─────────────────────────────────────────────────────────────────

interface ScopeRow {
  id: string;
  site_id: string;
  site_name: string;
  cidr: string;
  label: string | null;
  enabled: boolean;
  last_scan_at: string | null;
  vlan_id: number | null;
  gateway: string | null;
  dns_servers: string[];
  dhcp_start: string | null;
  dhcp_end: string | null;
  notes: string | null;
}

const SCOPES = `
  SELECT s.id, s.site_id, si.name AS site_name, s.cidr::text AS cidr, s.label, s.enabled, s.last_run_finished_at AS last_scan_at,
         m.vlan_id, host(m.gateway) AS gateway, coalesce(ARRAY(SELECT host(x) FROM unnest(m.dns_servers) AS x), '{}') AS dns_servers,
         host(m.dhcp_start) AS dhcp_start, host(m.dhcp_end) AS dhcp_end, m.notes
    FROM network_scopes s
    JOIN sites si ON si.id = s.site_id
    LEFT JOIN ipam_subnets m ON m.scope_id = s.id`;

const RECORD = `id, site_id, host(ip) AS ip, kind, label, mac::text AS mac, notes, updated_at`;

/** Everything observed and documented for the given sites, loaded once and split per subnet in memory. */
async function loadFacts(db: Db, siteIds: string[]) {
  const devices = (
    await db.query<ObservedDevice & { site_id: string }>(
      `SELECT id, site_id, host(current_ip) AS ip, coalesce(display_name, hostname, host(current_ip)) AS label, primary_mac::text AS mac,
              device_type, status, last_seen_at
         FROM devices WHERE site_id = ANY($1) AND current_ip IS NOT NULL AND family(current_ip) = 4`,
      [siteIds],
    )
  ).rows.map((d) => ({ ...d, last_seen_at: new Date(d.last_seen_at).toISOString() }));
  const records = (await db.query<IpamRecord>(`SELECT ${RECORD} FROM ipam_addresses WHERE site_id = ANY($1)`, [siteIds])).rows;
  const collectors = (
    await db.query<{ site_id: string; gateway_ip: string | null; interfaces: { addresses?: string[] }[] }>(
      `SELECT site_id, host(gateway_ip) AS gateway_ip, interfaces FROM collectors WHERE site_id = ANY($1) AND status = 'active'`,
      [siteIds],
    )
  ).rows;
  return { devices, records, collectors };
}

type Facts = Awaited<ReturnType<typeof loadFacts>>;

function planFor(scope: ScopeRow, facts: Facts) {
  const collectors = facts.collectors.filter((c) => c.site_id === scope.site_id);
  const observedGateway = collectors.map((c) => c.gateway_ip).find((ip) => ip && cidrContains(scope.cidr, ip)) ?? null;
  const gateway = scope.gateway ? { ip: scope.gateway, source: 'documented' as const } : observedGateway ? { ip: observedGateway, source: 'observed' as const } : null;
  const collectorIps = collectors.flatMap((c) => (c.interfaces ?? []).flatMap((i) => (i.addresses ?? []).map((a) => a.split('/')[0]!))).filter(isIPv4);
  const dhcp = scope.dhcp_start && scope.dhcp_end ? { start: scope.dhcp_start, end: scope.dhcp_end } : null;
  const plan = buildPlan({
    cidr: scope.cidr,
    devices: facts.devices.filter((d) => d.site_id === scope.site_id),
    records: facts.records.filter((r) => r.site_id === scope.site_id),
    gateway,
    collectorIps: [...new Set(collectorIps)],
    dhcp,
  });
  return { plan, gateway, dhcp };
}

function summarize(scope: ScopeRow, facts: Facts): IpamSubnetSummary & { detail: ReturnType<typeof planFor> } {
  const detail = planFor(scope, facts);
  return {
    id: scope.id,
    site_id: scope.site_id,
    site_name: scope.site_name,
    cidr: scope.cidr,
    label: scope.label,
    enabled: scope.enabled,
    last_scan_at: scope.last_scan_at,
    vlan_id: scope.vlan_id,
    gateway: detail.gateway,
    ...detail.plan.counts,
    conflicts: detail.plan.conflicts.length,
    detail,
  };
}

async function loadSubnet(db: Db, id: string): Promise<IpamSubnetDetail> {
  const scope = (await db.query<ScopeRow>(`${SCOPES} WHERE s.id = $1`, [id])).rows[0];
  if (!scope) throw notFound('Subnet');
  const { detail, ...summary } = summarize(scope, await loadFacts(db, [scope.site_id]));
  const m = subnetMath(scope.cidr);
  return {
    ...summary,
    network: intToIp(m.network),
    broadcast: intToIp(m.broadcast),
    netmask: intToIp(m.prefix === 0 ? 0 : (0xffffffff << (32 - m.prefix)) >>> 0),
    first_host: intToIp(m.first),
    last_host: intToIp(m.last),
    dns_servers: scope.dns_servers,
    dhcp: detail.dhcp,
    notes: scope.notes,
    addresses: detail.plan.addresses,
    conflict_list: detail.plan.conflicts,
    next_free: detail.plan.next_free,
  };
}

// ── conflict events ─────────────────────────────────────────────────────────

const CONFLICT_TITLE: Record<IpamConflict['kind'], (ip: string) => string> = {
  duplicate_ip: (ip) => `Two devices are using the address ${ip}`,
  reserved_in_use: (ip) => `The reserved address ${ip} is in use`,
  assignment_mismatch: (ip) => `${ip} is used by a different device than documented`,
  static_in_dhcp_pool: (ip) => `The static address ${ip} is inside the DHCP pool`,
};

/**
 * Compares the conflicts of a site with those already open and raises one event per conflict that
 * appeared and one per conflict that cleared. Called after a discovery sweep was applied and after
 * the documentation changed. Idempotent.
 */
export async function syncIpamConflicts(db: Db, organizationId: string, siteId: string, at: Date, collectorId: string | null = null): Promise<void> {
  const scopes = (await db.query<ScopeRow>(`${SCOPES} WHERE s.site_id = $1`, [siteId])).rows;
  const open = (await db.query<{ ip: string; kind: IpamConflict['kind'] }>(`SELECT host(ip) AS ip, kind FROM ipam_open_conflicts WHERE site_id = $1`, [siteId])).rows;
  if (!scopes.length && !open.length) return;
  const facts = scopes.length ? await loadFacts(db, [siteId]) : null;
  const current = new Map<string, { conflict: IpamConflict; deviceId: string | null }>();
  for (const scope of scopes) {
    const { plan } = planFor(scope, facts!);
    for (const conflict of plan.conflicts) {
      const online = plan.addresses.find((a) => a.ip === conflict.ip)?.devices.find((d) => d.status === 'online');
      current.set(`${conflict.ip}|${conflict.kind}`, { conflict, deviceId: online?.id ?? null });
    }
  }
  const known = new Set(open.map((o) => `${o.ip}|${o.kind}`));
  let changed = false;
  for (const [key, { conflict, deviceId }] of current) {
    if (known.has(key)) continue;
    changed = true;
    await db.query(`INSERT INTO ipam_open_conflicts (site_id, ip, kind, organization_id, opened_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [siteId, conflict.ip, conflict.kind, organizationId, at]);
    await emitEvent(db, organizationId, {
      siteId,
      deviceId,
      collectorId,
      type: 'ip_conflict',
      // A documentation inconsistency is worth knowing; two machines fighting over an address is a fault.
      severity: conflict.kind === 'static_in_dhcp_pool' ? 'info' : 'warning',
      title: CONFLICT_TITLE[conflict.kind](conflict.ip),
      details: { ip: conflict.ip, kind: conflict.kind, evidence: conflict.evidence, source: 'Discovery results compared with the IPAM records' },
      source: 'platform',
      occurredAt: at,
    });
  }
  for (const o of open) {
    if (current.has(`${o.ip}|${o.kind}`)) continue;
    changed = true;
    await db.query(`DELETE FROM ipam_open_conflicts WHERE site_id = $1 AND ip = $2::inet AND kind = $3`, [siteId, o.ip, o.kind]);
    await emitEvent(db, organizationId, {
      siteId,
      collectorId,
      type: 'ip_conflict_resolved',
      severity: 'info',
      title: `The address conflict on ${o.ip} is resolved`,
      details: { ip: o.ip, kind: o.kind },
      source: 'platform',
      occurredAt: at,
    });
  }
  if (changed) await notifyRealtime(db, organizationId, 'events');
}

// ── subnets ─────────────────────────────────────────────────────────────────

ipamRouter.get('/ipam/subnets', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(z.object({ site_id: z.uuid().optional() }), req.query);
  const items = await withTenant(ctx.organizationId, async (db) => {
    const scopes = (await db.query<ScopeRow>(`${SCOPES} WHERE ($1::uuid IS NULL OR s.site_id = $1) ORDER BY si.name, s.cidr`, [site_id ?? null])).rows;
    if (!scopes.length) return [];
    const facts = await loadFacts(db, [...new Set(scopes.map((s) => s.site_id))]);
    return scopes.map((s) => {
      const { detail: _detail, ...summary } = summarize(s, facts);
      return summary;
    });
  });
  res.json({ items });
});

ipamRouter.get('/ipam/subnets/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await withTenant(ctx.organizationId, (db) => loadSubnet(db, id)));
});

const ipv4 = z.string().trim().refine(isIPv4, 'Not a valid IPv4 address');

const subnetBody = z
  .object({
    vlan_id: z.number().int().min(1).max(4094).nullable(),
    gateway: ipv4.nullable(),
    dns_servers: z.array(ipv4).max(4),
    dhcp_start: ipv4.nullable(),
    dhcp_end: ipv4.nullable(),
    notes: z.string().trim().max(1000).nullable(),
  })
  .strict();

ipamRouter.put('/ipam/subnets/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(subnetBody, req.body);
  const detail = await withTenant(ctx.organizationId, async (db) => {
    const scope = (await db.query<{ cidr: string; site_id: string }>(`SELECT cidr::text AS cidr, site_id FROM network_scopes WHERE id = $1`, [id])).rows[0];
    if (!scope) throw notFound('Subnet');
    const invalid = (message: string) => new AppError(422, 'invalid_plan', message);
    if (body.gateway && !cidrContains(scope.cidr, body.gateway)) throw invalid(`The gateway must be inside ${scope.cidr}`);
    if (Boolean(body.dhcp_start) !== Boolean(body.dhcp_end)) throw invalid('Give both the first and the last address of the DHCP pool, or neither');
    if (body.dhcp_start && body.dhcp_end) {
      if (!cidrContains(scope.cidr, body.dhcp_start) || !cidrContains(scope.cidr, body.dhcp_end)) throw invalid(`The DHCP pool must be inside ${scope.cidr}`);
      if (ipToInt(body.dhcp_start) > ipToInt(body.dhcp_end)) throw invalid('The DHCP pool ends before it starts');
    }
    await db.query(
      `INSERT INTO ipam_subnets (scope_id, organization_id, vlan_id, gateway, dns_servers, dhcp_start, dhcp_end, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5::inet[],$6,$7,$8,$9)
       ON CONFLICT (scope_id) DO UPDATE SET vlan_id = EXCLUDED.vlan_id, gateway = EXCLUDED.gateway, dns_servers = EXCLUDED.dns_servers,
         dhcp_start = EXCLUDED.dhcp_start, dhcp_end = EXCLUDED.dhcp_end, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [id, ctx.organizationId, body.vlan_id, body.gateway, body.dns_servers, body.dhcp_start, body.dhcp_end, body.notes || null, ctx.userId],
    );
    await audit(db, req, 'ipam.subnet_documented', { type: 'network_scope', id }, { cidr: scope.cidr, ...body });
    await syncIpamConflicts(db, ctx.organizationId, scope.site_id, new Date());
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return loadSubnet(db, id);
  });
  res.json(detail);
});

// CSV of every observed or documented address of the subnet.
ipamRouter.get('/ipam/subnets/:id/export.csv', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const subnet = await withTenant(ctx.organizationId, (db) => loadSubnet(db, id));
  const lines = [['ip', 'state', 'device', 'mac', 'device_type', 'last_seen_at', 'documented_as', 'documented_label', 'documented_mac', 'notes', 'flags', 'conflict'].join(',')];
  for (const a of subnet.addresses) {
    const d = a.devices[0];
    lines.push(
      [a.ip, a.state, d?.label, d?.mac, d?.device_type, d?.last_seen_at, a.record?.kind, a.record?.label, a.record?.mac, a.record?.notes, a.flags.join(' '), a.conflict].map(csvCell).join(','),
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ipam-${subnet.cidr.replace('/', '_')}.csv"`);
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});

// ── documented addresses ────────────────────────────────────────────────────

const mac = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/, 'Not a valid MAC address (example: 00:11:22:33:44:55)')
  .transform(normalizeMac);

const recordFields = {
  kind: z.enum(['static', 'dhcp_reservation', 'reserved']),
  label: z.string().trim().min(1).max(80),
  mac: mac.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
};
const createRecord = z.object({ site_id: z.uuid(), ip: ipv4, ...recordFields }).strict();
const patchRecord = z.object(recordFields).partial().strict();

function checkRecord(kind: string, recordMac: string | null) {
  if (kind === 'dhcp_reservation' && !recordMac) throw new AppError(422, 'mac_required', 'A DHCP reservation is for one MAC address: enter it');
  if (kind === 'reserved' && recordMac) throw new AppError(422, 'mac_not_allowed', 'A reserved address is kept free, so it has no MAC address');
}

ipamRouter.post('/ipam/addresses', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(createRecord, req.body);
  checkRecord(body.kind, body.mac ?? null);
  const record = await withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [body.site_id])).rowCount) throw notFound('Site');
    const scope = (await db.query<{ cidr: string }>(`SELECT cidr::text AS cidr FROM network_scopes WHERE site_id = $1 AND $2::inet <<= cidr`, [body.site_id, body.ip])).rows[0];
    if (!scope) throw new AppError(422, 'not_in_subnet', 'This address is not inside a subnet of the site');
    const m = subnetMath(scope.cidr);
    const n = ipToInt(body.ip);
    if (n < m.first || n > m.last) throw new AppError(422, 'not_a_host_address', `${body.ip} is the network or broadcast address of ${scope.cidr}`);
    if ((await db.query(`SELECT 1 FROM ipam_addresses WHERE site_id = $1 AND ip = $2::inet`, [body.site_id, body.ip])).rowCount) {
      throw new AppError(409, 'already_documented', 'This address is already documented');
    }
    const row = (
      await db.query<IpamRecord>(
        `INSERT INTO ipam_addresses (organization_id, site_id, ip, kind, label, mac, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${RECORD}`,
        [ctx.organizationId, body.site_id, body.ip, body.kind, body.label, body.mac ?? null, body.notes || null, ctx.userId],
      )
    ).rows[0]!;
    await audit(db, req, 'ipam.address_documented', { type: 'ipam_address', id: row.id }, { ip: row.ip, kind: row.kind, label: row.label, mac: row.mac });
    await syncIpamConflicts(db, ctx.organizationId, body.site_id, new Date());
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return row;
  });
  res.status(201).json(record);
});

ipamRouter.patch('/ipam/addresses/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(patchRecord, req.body);
  const record = await withTenant(ctx.organizationId, async (db) => {
    const current = (await db.query<IpamRecord>(`SELECT ${RECORD} FROM ipam_addresses WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!current) throw notFound('Address');
    const next = {
      kind: body.kind ?? current.kind,
      label: body.label ?? current.label,
      mac: body.mac === undefined ? current.mac : body.mac,
      notes: body.notes === undefined ? current.notes : body.notes || null,
    };
    checkRecord(next.kind, next.mac);
    const row = (
      await db.query<IpamRecord>(`UPDATE ipam_addresses SET kind = $2, label = $3, mac = $4, notes = $5, updated_at = now() WHERE id = $1 RETURNING ${RECORD}`, [
        id,
        next.kind,
        next.label,
        next.mac,
        next.notes,
      ])
    ).rows[0]!;
    await audit(db, req, 'ipam.address_updated', { type: 'ipam_address', id }, { ip: row.ip, ...body });
    await syncIpamConflicts(db, ctx.organizationId, row.site_id, new Date());
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return row;
  });
  res.json(record);
});

ipamRouter.delete('/ipam/addresses/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const gone = (await db.query<{ ip: string; label: string; site_id: string }>(`DELETE FROM ipam_addresses WHERE id = $1 RETURNING host(ip) AS ip, label, site_id`, [id])).rows[0];
    if (!gone) throw notFound('Address');
    await audit(db, req, 'ipam.address_removed', { type: 'ipam_address', id }, { ip: gone.ip, label: gone.label });
    await syncIpamConflicts(db, ctx.organizationId, gone.site_id, new Date());
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
  res.status(204).end();
});

// ── who has held this address? ──────────────────────────────────────────────

ipamRouter.get('/ipam/history', async (req, res) => {
  const ctx = auth(req);
  const q = parse(z.object({ site_id: z.uuid(), ip: ipv4 }), req.query);
  const items = await withTenant(
    ctx.organizationId,
    async (db) =>
      (
        await db.query<IpamHistoryEntry>(
          `SELECT d.id AS device_id, coalesce(d.display_name, d.hostname, d.primary_mac::text, host(d.current_ip)) AS label, d.primary_mac::text AS mac, d.status,
                  (d.current_ip = h.ip) AS current, h.first_seen_at, h.last_seen_at
             FROM device_ip_history h JOIN devices d ON d.id = h.device_id
            WHERE d.site_id = $1 AND h.ip = $2::inet
            ORDER BY h.last_seen_at DESC LIMIT 50`,
          [q.site_id, q.ip],
        )
      ).rows,
  );
  res.json({ items });
});
