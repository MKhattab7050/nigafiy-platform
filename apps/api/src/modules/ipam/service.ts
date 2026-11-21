import type { Request } from 'express';
import type { IpamHistoryEntry, IpamRecord, IpamSubnetDetail } from '@lan-detective/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../common/http.ts';
import { cidrContains } from '../../common/net.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { syncIpamConflicts } from './conflicts.ts';
import { RECORD, type ScopeRow, SCOPES, loadFacts, loadSubnet, summarize } from './facts.ts';
import { csvCell, ipToInt, subnetMath } from './plan.ts';
import type { CreateRecord, PatchRecord, SubnetBody } from './schema.ts';

// IPAM use cases. Every documentation change re-compares the site with what was observed
// (syncIpamConflicts). `req` is passed only for the audit trail.

// ── subnets ─────────────────────────────────────────────────────────────────

export function listSubnets(organizationId: string, siteId: string | undefined) {
  return withTenant(organizationId, async (db) => {
    const scopes = (await db.query<ScopeRow>(`${SCOPES} WHERE ($1::uuid IS NULL OR s.site_id = $1) ORDER BY si.name, s.cidr`, [siteId ?? null])).rows;
    if (!scopes.length) return [];
    const facts = await loadFacts(db, [...new Set(scopes.map((s) => s.site_id))]);
    return scopes.map((s) => {
      const { detail: _detail, ...summary } = summarize(s, facts);
      return summary;
    });
  });
}

export function getSubnet(organizationId: string, id: string): Promise<IpamSubnetDetail> {
  return withTenant(organizationId, (db) => loadSubnet(db, id));
}

export function documentSubnet(req: Request, ctx: AuthContext, id: string, body: SubnetBody): Promise<IpamSubnetDetail> {
  return withTenant(ctx.organizationId, async (db) => {
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
}

/** CSV of every observed or documented address of the subnet (UTF-8 with BOM, CRLF lines). */
export function subnetCsv(subnet: IpamSubnetDetail): string {
  const lines = [['ip', 'state', 'device', 'mac', 'device_type', 'last_seen_at', 'documented_as', 'documented_label', 'documented_mac', 'notes', 'flags', 'conflict'].join(',')];
  for (const a of subnet.addresses) {
    const d = a.devices[0];
    lines.push(
      [a.ip, a.state, d?.label, d?.mac, d?.device_type, d?.last_seen_at, a.record?.kind, a.record?.label, a.record?.mac, a.record?.notes, a.flags.join(' '), a.conflict].map(csvCell).join(','),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ── documented addresses ────────────────────────────────────────────────────

function checkRecord(kind: string, recordMac: string | null) {
  if (kind === 'dhcp_reservation' && !recordMac) throw new AppError(422, 'mac_required', 'A DHCP reservation is for one MAC address: enter it');
  if (kind === 'reserved' && recordMac) throw new AppError(422, 'mac_not_allowed', 'A reserved address is kept free, so it has no MAC address');
}

export function documentAddress(req: Request, ctx: AuthContext, body: CreateRecord): Promise<IpamRecord> {
  checkRecord(body.kind, body.mac ?? null);
  return withTenant(ctx.organizationId, async (db) => {
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
}

export function updateAddress(req: Request, ctx: AuthContext, id: string, body: PatchRecord): Promise<IpamRecord> {
  return withTenant(ctx.organizationId, async (db) => {
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
}

export async function removeAddress(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const gone = (await db.query<{ ip: string; label: string; site_id: string }>(`DELETE FROM ipam_addresses WHERE id = $1 RETURNING host(ip) AS ip, label, site_id`, [id])).rows[0];
    if (!gone) throw notFound('Address');
    await audit(db, req, 'ipam.address_removed', { type: 'ipam_address', id }, { ip: gone.ip, label: gone.label });
    await syncIpamConflicts(db, ctx.organizationId, gone.site_id, new Date());
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

// ── who has held this address? ──────────────────────────────────────────────

export function addressHistory(organizationId: string, siteId: string, ip: string): Promise<IpamHistoryEntry[]> {
  return withTenant(
    organizationId,
    async (db) =>
      (
        await db.query<IpamHistoryEntry>(
          `SELECT d.id AS device_id, coalesce(d.display_name, d.hostname, d.primary_mac::text, host(d.current_ip)) AS label, d.primary_mac::text AS mac, d.status,
                  (d.current_ip = h.ip) AS current, h.first_seen_at, h.last_seen_at
             FROM device_ip_history h JOIN devices d ON d.id = h.device_id
            WHERE d.site_id = $1 AND h.ip = $2::inet
            ORDER BY h.last_seen_at DESC LIMIT 50`,
          [siteId, ip],
        )
      ).rows,
  );
}
