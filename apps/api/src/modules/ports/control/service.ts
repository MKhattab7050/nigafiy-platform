import type { Request } from 'express';
import { audit, auditSystem } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { type Credentials, seal } from '../credentials.ts';
import { type PortLocation, type Sighting, locate, portRole } from '../locate.ts';
import { PORT_REQUEST_TTL_MINUTES, type PortAction, type PortChange } from './schema.ts';

// Port control (Phase 5): switch port changes over SNMP SET through the site's collector.
//
//  - Nothing changes a port without an administrator's explicit, confirmed request.
//  - A disruptive change (disable a port, move it to another VLAN) on a port that looks like an
//    uplink, a trunk, or the path to the collector / gateway / the requester's own machine is
//    refused unless the administrator writes an override reason. The collector re-checks the
//    "never cut yourself off" rule against the switch itself.
//  - Write credentials are sealed, never returned, and delivered to the site's collector only
//    while a change for that switch is pending (credentials.ts → buildSnmpConfig).
//  - A change not answered within PORT_REQUEST_TTL_MINUTES expires; the collector never runs it late.
//  - Success means "read back and verified" by the collector, never "the SET was accepted".

export type RiskCode = 'uplink' | 'many_devices' | 'trunk' | 'collector_port' | 'gateway_port' | 'own_machine';
export interface PortRisk {
  code: RiskCode;
  /** observed: seen directly (LLDP, VLAN tables, a forwarding-table entry). inferred: concluded from a count. */
  source: 'observed' | 'inferred';
  evidence: string;
}

export interface TargetRow {
  id: string;
  site_id: string;
  name: string;
  enabled: boolean;
  in_scope: boolean;
  write_version: string | null;
  write_configured: boolean;
  write_updated_at: Date | null;
  vlan_methods: string[];
  vlans_read_at: Date | null;
  quarantine_vlan: number | null;
  sys_object_id: string | null;
}

const TARGET = `
  SELECT t.id, t.site_id, coalesce(t.name, t.sys_name, host(t.host)) AS name, t.enabled,
         EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = t.site_id AND s.enabled AND t.host <<= s.cidr) AS in_scope,
         t.write_version, (t.write_secret_enc IS NOT NULL) AS write_configured, t.write_updated_at,
         t.vlan_methods, t.vlans_read_at, t.quarantine_vlan, t.sys_object_id
    FROM snmp_targets t`;

export async function loadTarget(db: Db, id: string, lock = false): Promise<TargetRow> {
  const t = (await db.query<TargetRow>(`${TARGET} WHERE t.id = $1${lock ? ' FOR UPDATE OF t' : ''}`, [id])).rows[0];
  if (!t) throw notFound('Switch');
  return t;
}

/** The address a request came from, as the API sees it (IPv4-mapped IPv6 unwrapped). */
function requesterAddress(req: Request): string | null {
  const ip = req.ip ?? null;
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

async function onlineCollector(db: Db, siteId: string): Promise<{ id: string } | undefined> {
  return (
    await db.query<{ id: string }>(
      `SELECT id FROM collectors WHERE site_id = $1 AND status = 'active' AND last_heartbeat_at > now() - interval '3 minutes' ORDER BY last_heartbeat_at DESC LIMIT 1`,
      [siteId],
    )
  ).rows[0];
}

/**
 * Pending changes past their deadline become "expired"; the quarantine they belong to falls back
 * (requested → failed, releasing → active). Their commands are closed so they are not re-sent.
 */
export async function expireStalePortRequests(db: Db): Promise<void> {
  const expired = (
    await db.query<{ id: string; purpose: string; quarantine_id: string | null }>(
      `UPDATE switch_port_requests SET status = 'expired', error_kind = 'expired', completed_at = now(),
              error = 'The collector did not report a result in time; it does not run a change after its deadline'
        WHERE status = 'pending' AND expires_at <= now()
        RETURNING id, purpose, quarantine_id`,
    )
  ).rows;
  if (!expired.length) return;
  await db.query(
    `UPDATE collector_commands SET status = 'completed', completed_at = now()
      WHERE kind = 'set_switch_port' AND status <> 'completed' AND payload->>'request_id' = ANY($1::text[])`,
    [expired.map((e) => e.id)],
  );
  for (const e of expired) {
    if (!e.quarantine_id) continue;
    if (e.purpose === 'quarantine') {
      await db.query(`UPDATE device_quarantines SET status = 'failed', last_error = 'The change expired before the collector ran it' WHERE id = $1 AND status = 'requested'`, [e.quarantine_id]);
    } else if (e.purpose === 'release') {
      await db.query(`UPDATE device_quarantines SET status = 'active', last_error = 'The release expired before the collector ran it' WHERE id = $1 AND status = 'releasing'`, [e.quarantine_id]);
    }
  }
}

interface PortFacts {
  name: string;
  alias: string | null;
  admin_up: boolean;
  oper_up: boolean;
  mac_count: number;
  neighbors: { sys_name?: string; port_id?: string }[];
  updated_at: Date;
  access_vlan: number | null;
  mode: 'access' | 'trunk' | 'unknown' | null;
  vlan_source: 'qbridge' | 'cisco' | null;
  vlan_updated_at: Date | null;
}

async function loadPort(db: Db, targetId: string, ifIndex: number): Promise<PortFacts> {
  const p = (
    await db.query<PortFacts>(
      `SELECT p.name, p.alias, p.admin_up, p.oper_up, p.mac_count, p.neighbors, p.updated_at,
              v.access_vlan, v.mode, v.source AS vlan_source, v.updated_at AS vlan_updated_at
         FROM switch_ports p
         LEFT JOIN switch_port_vlans v ON v.target_id = p.target_id AND v.if_index = p.if_index
        WHERE p.target_id = $1 AND p.if_index = $2`,
      [targetId, ifIndex],
    )
  ).rows[0];
  if (!p) throw notFound('Port');
  return p;
}

/** What makes a disruptive change on this port risky, from what Nigafiy observed. */
export async function portRisks(db: Db, t: TargetRow, ifIndex: number, p: PortFacts, requesterIp: string | null): Promise<PortRisk[]> {
  const risks: PortRisk[] = [];
  const role = portRole(p);
  if (role === 'uplink') {
    const n = p.neighbors[0];
    risks.push({ code: 'uplink', source: 'observed', evidence: `LLDP neighbour heard on this port${n?.sys_name ? `: ${n.sys_name}${n.port_id ? ` (${n.port_id})` : ''}` : ''}` });
  } else if (role === 'trunk') {
    risks.push({ code: 'many_devices', source: 'inferred', evidence: `${p.mac_count} addresses learned on this port: probably an uplink, a desk switch or an access point` });
  }
  if (p.mode === 'trunk') risks.push({ code: 'trunk', source: 'observed', evidence: `The switch's VLAN table (${p.vlan_source}) shows this port carrying several VLANs (tagged)` });
  const protectedHere = (
    await db.query<{ mac: string; label: string; collector: boolean; gateway: boolean; own: boolean }>(
      `SELECT d.primary_mac::text AS mac, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS label,
              ('local_interface' = ANY(coalesce(d.discovery_sources, '{}'))
                OR EXISTS (SELECT 1 FROM collectors c, jsonb_array_elements(coalesce(c.interfaces, '[]'::jsonb)) i, jsonb_array_elements_text(i->'addresses') a
                            WHERE c.site_id = d.site_id AND c.status = 'active' AND d.current_ip IS NOT NULL AND split_part(a, '/', 1) = host(d.current_ip))) AS collector,
              (EXISTS (SELECT 1 FROM site_routers r WHERE r.site_id = d.site_id AND (r.device_id = d.id OR r.address = d.current_ip))
                OR EXISTS (SELECT 1 FROM collectors c WHERE c.site_id = d.site_id AND c.gateway_ip IS NOT NULL AND c.gateway_ip = d.current_ip)) AS gateway,
              ($4::text IS NOT NULL AND host(d.current_ip) = $4) AS own
         FROM switch_fdb f
         JOIN devices d ON d.site_id = $3 AND d.primary_mac = f.mac
        WHERE f.target_id = $1 AND f.if_index = $2`,
      [t.id, ifIndex, t.site_id, requesterIp],
    )
  ).rows;
  const once = new Set<RiskCode>();
  for (const d of protectedHere) {
    const add = (code: RiskCode, what: string) => {
      if (once.has(code)) return;
      once.add(code);
      risks.push({ code, source: 'observed', evidence: `${what} (${d.label}, ${d.mac}) is in this port's forwarding table` });
    };
    if (d.collector) add('collector_port', 'The computer running the Nigafiy collector');
    if (d.gateway) add('gateway_port', 'The router / network gateway');
    if (d.own) add('own_machine', 'The machine you are using right now');
  }
  return risks;
}

const isDisruptive = (c: PortChange) => (c.op === 'admin_status' && !c.admin_up) || c.op === 'access_vlan';

interface QueueInput {
  t: TargetRow;
  ifIndex: number;
  port: PortFacts;
  change: PortChange;
  risks: PortRisk[];
  overrideReason: string | null;
  purpose: 'manual' | 'quarantine' | 'release';
  quarantineId?: string | null;
}

/** Records the request and queues the `set_switch_port` command for an online collector of the site. */
/** Who queues a change: a signed-in administrator, or Nigafiy itself (userId null, `via` set). */
type PortActor = Pick<AuthContext, 'organizationId'> & { userId: string | null; userEmail: string | null; via?: string };

async function queueChange(db: Db, ctx: PortActor, q: QueueInput): Promise<{ request_id: string; expires_at: Date; method: string | null }> {
  const { t, ifIndex, port, change } = q;
  if (!t.enabled) throw new AppError(409, 'switch_disabled', 'This switch is disabled; enable it before changing its ports');
  if (!t.in_scope) throw new AppError(409, 'not_in_scope', 'The switch address is not inside an authorized network range of the site');
  if (!t.write_configured) {
    throw new AppError(409, 'write_not_configured', 'Enter this switch’s SNMP write credentials first; the read-only credentials cannot change ports');
  }
  let method: string | null = 'ifmib';
  if (change.op === 'access_vlan') {
    if (!t.vlan_methods.length) {
      throw new AppError(409, 'vlans_unknown', 'The switch’s VLAN tables have not been read (it needs Q-BRIDGE-MIB or the Cisco VLAN MIB); read it again or check its SNMP view');
    }
    method = port.vlan_source && t.vlan_methods.includes(port.vlan_source) ? port.vlan_source : t.vlan_methods[0]!;
    const known = await db.query(`SELECT 1 FROM switch_vlans WHERE target_id = $1 AND vlan_id = $2`, [t.id, change.vlan]);
    if (!known.rowCount) throw new AppError(422, 'vlan_not_found', `VLAN ${change.vlan} is not defined on this switch (as last read)`);
    if (q.purpose !== 'release' && port.access_vlan === change.vlan) throw new AppError(409, 'no_change', `The port is already in VLAN ${change.vlan} (as last read)`);
  }
  const pending = await db.query(`SELECT 1 FROM switch_port_requests WHERE target_id = $1 AND if_index = $2 AND status = 'pending'`, [t.id, ifIndex]);
  if (pending.rowCount) throw new AppError(409, 'change_pending', 'A change of this port is still waiting for the collector');
  const collector = await onlineCollector(db, t.site_id);
  if (!collector) throw new AppError(409, 'no_collector', 'No collector of this site is online to reach the switch');

  const params = change.op === 'admin_status' ? { admin_up: change.admin_up } : change.op === 'alias' ? { alias: change.alias } : { vlan: change.vlan };
  const before = {
    admin_up: port.admin_up,
    oper_up: port.oper_up,
    alias: port.alias,
    vlan: port.access_vlan,
    mode: port.mode,
    read_at: port.updated_at,
    vlan_read_at: port.vlan_updated_at,
    source: 'last_read',
  };
  const row = (
    await db.query<{ id: string; expires_at: Date }>(
      `INSERT INTO switch_port_requests (organization_id, site_id, target_id, collector_id, if_index, port_name, op, params, method, before_known, risks,
                                         override_reason, purpose, quarantine_id, created_by, created_by_email, requested_via, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$18, now() + make_interval(mins => $17))
       RETURNING id, expires_at`,
      [
        ctx.organizationId, t.site_id, t.id, collector.id, ifIndex, port.name, change.op, JSON.stringify(params), method, JSON.stringify(before),
        JSON.stringify(q.risks), q.overrideReason, q.purpose, q.quarantineId ?? null, ctx.userId, ctx.userEmail, PORT_REQUEST_TTL_MINUTES,
        ctx.via ?? 'user',
      ],
    )
  ).rows[0]!;
  const payload: Record<string, unknown> = {
    request_id: row.id,
    target_id: t.id,
    if_index: ifIndex,
    op: change.op,
    ...params,
    expires_at: row.expires_at.toISOString(),
    override: Boolean(q.overrideReason),
  };
  if (change.op === 'access_vlan') payload.method = method;
  await db.query(`INSERT INTO collector_commands (organization_id, collector_id, kind, payload, created_by) VALUES ($1,$2,'set_switch_port',$3,$4)`, [
    ctx.organizationId,
    collector.id,
    JSON.stringify(payload),
    ctx.userId,
  ]);
  return { request_id: row.id, expires_at: row.expires_at, method };
}

/** POST /switches/:id/ports/:ifIndex/actions — one confirmed change of one port. */
export function requestPortChange(req: Request, ctx: AuthContext, targetId: string, ifIndex: number, body: PortAction) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStalePortRequests(db);
    const t = await loadTarget(db, targetId, true);
    const port = await loadPort(db, targetId, ifIndex);
    const change: PortChange =
      body.op === 'admin_status' ? { op: 'admin_status', admin_up: body.admin_up } : body.op === 'alias' ? { op: 'alias', alias: body.alias } : { op: 'access_vlan', vlan: body.vlan };
    const override = 'override_reason' in body ? (body.override_reason ?? null) : null;
    const risks = isDisruptive(change) ? await portRisks(db, t, ifIndex, port, requesterAddress(req)) : [];
    if (risks.length && !override) {
      throw new AppError(409, 'risky_port', 'This port looks like an uplink, a trunk or the path to Nigafiy itself. Give a reason to proceed anyway.', { risks });
    }
    const quarantined = await db.query(`SELECT 1 FROM device_quarantines WHERE target_id = $1 AND if_index = $2 AND status IN ('requested','active','releasing')`, [t.id, ifIndex]);
    if (quarantined.rowCount && change.op === 'access_vlan') {
      throw new AppError(409, 'port_quarantined', 'A device on this port is quarantined; release it from the device page instead of changing the VLAN here');
    }
    const q = await queueChange(db, ctx, { t, ifIndex, port, change, risks, overrideReason: override, purpose: 'manual' });
    await audit(db, req, `switch_port.${change.op}`, { type: 'snmp_target', id: t.id }, {
      request_id: q.request_id,
      switch: t.name,
      if_index: ifIndex,
      port: port.name,
      change,
      before: { admin_up: port.admin_up, alias: port.alias, vlan: port.access_vlan },
      risks: risks.map((r) => r.code),
      override_reason: override,
    });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return { ...q, status: 'pending', risks };
  });
}

/** GET /switches/:id/ports/:ifIndex/control — what can be changed on this port, and what makes it risky. */
export function portControl(req: Request, organizationId: string, targetId: string, ifIndex: number) {
  return withTenant(organizationId, async (db) => {
    await expireStalePortRequests(db);
    const t = await loadTarget(db, targetId);
    const port = await loadPort(db, targetId, ifIndex);
    const risks = await portRisks(db, t, ifIndex, port, requesterAddress(req));
    const pending = (await db.query(`${REQUEST_SELECT} WHERE q.target_id = $1 AND q.if_index = $2 AND q.status = 'pending'`, [t.id, ifIndex])).rows[0] ?? null;
    const quarantine =
      (
        await db.query(
          `SELECT q.id, q.device_id, coalesce(d.display_name, d.hostname, host(d.current_ip)) AS device_label, q.status, q.original_vlan, q.quarantine_vlan, q.created_at
             FROM device_quarantines q JOIN devices d ON d.id = q.device_id
            WHERE q.target_id = $1 AND q.if_index = $2 AND q.status IN ('requested','active','releasing')`,
          [t.id, ifIndex],
        )
      ).rows[0] ?? null;
    const vlans = (await db.query<{ id: number; name: string | null; source: string }>(`SELECT vlan_id AS id, name, source FROM switch_vlans WHERE target_id = $1 ORDER BY vlan_id`, [t.id])).rows;
    const collector = await onlineCollector(db, t.site_id);
    const blocker = !t.enabled
      ? 'switch_disabled'
      : !t.in_scope
        ? 'not_in_scope'
        : !t.write_configured
          ? 'write_not_configured'
          : !collector
            ? 'no_collector'
            : pending
              ? 'change_pending'
              : null;
    return {
      target_id: t.id,
      switch_name: t.name,
      if_index: ifIndex,
      port: {
        name: port.name,
        alias: port.alias,
        admin_up: port.admin_up,
        oper_up: port.oper_up,
        role: portRole(port),
        read_at: port.updated_at,
        // VLAN membership as read from the switch's VLAN tables; null when they were not readable.
        vlan: port.mode ? { access_vlan: port.access_vlan, mode: port.mode, source: port.vlan_source, read_at: port.vlan_updated_at } : null,
      },
      write: { configured: t.write_configured, version: t.write_version, updated_at: t.write_updated_at },
      vlan_methods: t.vlan_methods,
      vlans,
      risks,
      quarantine,
      pending,
      blocker,
      actions: {
        admin_status: blocker ? { possible: false, reason: blocker } : { possible: true },
        alias: blocker ? { possible: false, reason: blocker } : { possible: true },
        access_vlan: blocker
          ? { possible: false, reason: blocker }
          : quarantine
            ? { possible: false, reason: 'port_quarantined' }
            : !t.vlan_methods.length || !vlans.length
              ? { possible: false, reason: 'vlans_unknown' }
              : { possible: true },
      },
      ttl_minutes: PORT_REQUEST_TTL_MINUTES,
    };
  });
}

/** GET /switches/:id/control — switch-level port-control settings and VLAN picture. */
export function switchControl(organizationId: string, targetId: string) {
  return withTenant(organizationId, async (db) => {
    await expireStalePortRequests(db);
    const t = await loadTarget(db, targetId);
    const vlans = (await db.query(`SELECT vlan_id AS id, name, source, updated_at FROM switch_vlans WHERE target_id = $1 ORDER BY vlan_id`, [t.id])).rows;
    const ports = (await db.query(`SELECT if_index, access_vlan, mode, source FROM switch_port_vlans WHERE target_id = $1 ORDER BY if_index`, [t.id])).rows;
    const site = (await db.query<{ quarantine_vlan: number | null }>(`SELECT quarantine_vlan FROM switch_port_settings WHERE site_id = $1`, [t.site_id])).rows[0];
    const pending = (await db.query(`${REQUEST_SELECT} WHERE q.target_id = $1 AND q.status = 'pending' ORDER BY q.created_at`, [t.id])).rows;
    const quarantines = (
      await db.query(
        `SELECT q.id, q.device_id, coalesce(d.display_name, d.hostname, host(d.current_ip)) AS device_label, q.if_index, q.port_name, q.status, q.original_vlan, q.quarantine_vlan, q.created_at
           FROM device_quarantines q JOIN devices d ON d.id = q.device_id
          WHERE q.target_id = $1 AND q.status IN ('requested','active','releasing') ORDER BY q.created_at DESC`,
        [t.id],
      )
    ).rows;
    return {
      target_id: t.id,
      site_id: t.site_id,
      write: { configured: t.write_configured, version: t.write_version, updated_at: t.write_updated_at },
      sys_object_id: t.sys_object_id,
      vlan_methods: t.vlan_methods,
      vlans_read_at: t.vlans_read_at,
      vlans,
      ports,
      quarantine_vlan: t.quarantine_vlan,
      site_quarantine_vlan: site?.quarantine_vlan ?? null,
      effective_quarantine_vlan: t.quarantine_vlan ?? site?.quarantine_vlan ?? null,
      pending,
      quarantines,
      ttl_minutes: PORT_REQUEST_TTL_MINUTES,
    };
  });
}

/** PUT /switches/:id/write-credentials — sealed, write-only; the audit trail records only that they changed. */
export function setWriteCredentials(req: Request, ctx: AuthContext, targetId: string, credentials: Credentials) {
  return withTenant(ctx.organizationId, async (db) => {
    const t = await loadTarget(db, targetId, true);
    await db.query(`UPDATE snmp_targets SET write_version = $2, write_secret_enc = $3, write_updated_at = now(), write_updated_by = $4 WHERE id = $1`, [
      t.id,
      credentials.version,
      seal(credentials),
      ctx.userId,
    ]);
    await audit(db, req, 'switch.write_credentials.set', { type: 'snmp_target', id: t.id }, { switch: t.name, version: credentials.version, replaced: t.write_configured });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

/** DELETE /switches/:id/write-credentials. Refused while a change is pending (it would fail half-way). */
export function clearWriteCredentials(req: Request, ctx: AuthContext, targetId: string) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStalePortRequests(db);
    const t = await loadTarget(db, targetId, true);
    if (!t.write_configured) return;
    const pending = await db.query(`SELECT 1 FROM switch_port_requests WHERE target_id = $1 AND status = 'pending'`, [t.id]);
    if (pending.rowCount) throw new AppError(409, 'change_pending', 'A port change of this switch is still waiting for the collector');
    await db.query(`UPDATE snmp_targets SET write_version = NULL, write_secret_enc = NULL, write_updated_at = now(), write_updated_by = $2 WHERE id = $1`, [t.id, ctx.userId]);
    await audit(db, req, 'switch.write_credentials.clear', { type: 'snmp_target', id: t.id }, { switch: t.name });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

/** PUT /switches/:id/quarantine-vlan — per-switch override of the site's quarantine VLAN (null: use the site's). */
export function setSwitchQuarantineVlan(req: Request, ctx: AuthContext, targetId: string, vlan: number | null) {
  return withTenant(ctx.organizationId, async (db) => {
    const t = await loadTarget(db, targetId, true);
    if (vlan !== null && t.vlans_read_at) {
      const known = await db.query(`SELECT 1 FROM switch_vlans WHERE target_id = $1 AND vlan_id = $2`, [t.id, vlan]);
      if (!known.rowCount) throw new AppError(422, 'vlan_not_found', `VLAN ${vlan} is not defined on this switch (as last read)`);
    }
    await db.query(`UPDATE snmp_targets SET quarantine_vlan = $2 WHERE id = $1`, [t.id, vlan]);
    await audit(db, req, 'switch.quarantine_vlan', { type: 'snmp_target', id: t.id }, { switch: t.name, from: t.quarantine_vlan, to: vlan });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

/** GET /sites/:id/port-control — the site's port-control settings and how its switches stand. */
export function sitePortControl(organizationId: string, siteId: string) {
  return withTenant(organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
    const s = (await db.query<{ quarantine_vlan: number | null; updated_at: Date }>(`SELECT quarantine_vlan, updated_at FROM switch_port_settings WHERE site_id = $1`, [siteId])).rows[0];
    const switches = (
      await db.query<{ id: string; name: string; write_configured: boolean; quarantine_vlan: number | null; has_site_vlan: boolean | null; vlans_read: boolean }>(
        `SELECT t.id, coalesce(t.name, t.sys_name, host(t.host)) AS name, (t.write_secret_enc IS NOT NULL) AS write_configured, t.quarantine_vlan,
                (t.vlans_read_at IS NOT NULL) AS vlans_read,
                CASE WHEN ps.quarantine_vlan IS NULL OR t.vlans_read_at IS NULL THEN NULL
                     ELSE EXISTS (SELECT 1 FROM switch_vlans v WHERE v.target_id = t.id AND v.vlan_id = coalesce(t.quarantine_vlan, ps.quarantine_vlan)) END AS has_site_vlan
           FROM snmp_targets t LEFT JOIN switch_port_settings ps ON ps.site_id = t.site_id
          WHERE t.site_id = $1 ORDER BY t.host`,
        [siteId],
      )
    ).rows;
    // VLANs defined on every read switch of the site: the natural candidates for a site-wide quarantine VLAN.
    const common = (
      await db.query<{ id: number; name: string | null; switches: number }>(
        `SELECT v.vlan_id AS id, min(v.name) AS name, count(*)::int AS switches
           FROM switch_vlans v JOIN snmp_targets t ON t.id = v.target_id
          WHERE t.site_id = $1 GROUP BY v.vlan_id ORDER BY v.vlan_id`,
        [siteId],
      )
    ).rows;
    return {
      site_id: siteId,
      quarantine_vlan: s?.quarantine_vlan ?? null,
      updated_at: s?.updated_at ?? null,
      switches: switches.map((x) => ({ ...x, quarantine_vlan_present: x.has_site_vlan })),
      vlans: common,
      ttl_minutes: PORT_REQUEST_TTL_MINUTES,
    };
  });
}

/** PUT /sites/:id/port-control. */
export function setSitePortControl(req: Request, ctx: AuthContext, siteId: string, quarantineVlan: number | null) {
  return withTenant(ctx.organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
    const before = (await db.query<{ quarantine_vlan: number | null }>(`SELECT quarantine_vlan FROM switch_port_settings WHERE site_id = $1`, [siteId])).rows[0];
    await db.query(
      `INSERT INTO switch_port_settings (site_id, organization_id, quarantine_vlan, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (site_id) DO UPDATE SET quarantine_vlan = EXCLUDED.quarantine_vlan, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [siteId, ctx.organizationId, quarantineVlan, ctx.userId],
    );
    await audit(db, req, 'site.port_control', { type: 'site', id: siteId }, { quarantine_vlan: { from: before?.quarantine_vlan ?? null, to: quarantineVlan } });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

export const REQUEST_SELECT = `
  SELECT q.id, q.site_id, q.target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, q.if_index, q.port_name, q.op, q.params, q.method,
         q.before_known, q.risks, q.override_reason, q.purpose, q.quarantine_id, q.requested_via, q.status, q.result, q.error, q.error_kind,
         q.created_by_email, q.created_at, q.expires_at, q.completed_at
    FROM switch_port_requests q JOIN snmp_targets t ON t.id = q.target_id`;

/** GET /port-requests — request history with before (as last read / as read by the collector) and after (read back). */
export function listPortRequests(organizationId: string, f: { target_id?: string; device_id?: string; if_index?: number; limit: number }) {
  return withTenant(organizationId, async (db) => {
    await expireStalePortRequests(db);
    const items = (
      await db.query(
        `${REQUEST_SELECT}
          WHERE ($1::uuid IS NULL OR q.target_id = $1)
            AND ($2::uuid IS NULL OR q.quarantine_id IN (SELECT id FROM device_quarantines WHERE device_id = $2))
            AND ($3::int IS NULL OR q.if_index = $3)
          ORDER BY q.created_at DESC LIMIT $4`,
        [f.target_id ?? null, f.device_id ?? null, f.if_index ?? null, f.limit],
      )
    ).rows;
    return { items };
  });
}

export function getPortRequest(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    await expireStalePortRequests(db);
    const row = (await db.query(`${REQUEST_SELECT} WHERE q.id = $1`, [id])).rows[0];
    if (!row) throw notFound('Port change');
    return row;
  });
}

// ── Quarantine ──────────────────────────────────────────────────────────────

async function locateForQuarantine(db: Db, deviceId: string) {
  const d = (
    await db.query<{ id: string; site_id: string; label: string; mac: string | null; ip: string | null }>(
      `SELECT id, site_id, coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS label, primary_mac::text AS mac, host(current_ip) AS ip FROM devices WHERE id = $1`,
      [deviceId],
    )
  ).rows[0];
  if (!d) throw notFound('Device');
  if (!d.mac) return { d, location: null as PortLocation | null };
  const sightings = (
    await db.query<Sighting>(
      `SELECT t.id AS target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, host(t.host) AS switch_host, f.if_index, p.name AS port_name, p.alias AS port_alias,
              f.vlan, p.mac_count, p.neighbors, p.oper_up, p.speed_mbps::int AS speed_mbps, f.last_seen_at
         FROM switch_fdb f
         JOIN snmp_targets t ON t.id = f.target_id AND t.site_id = $1
         JOIN switch_ports p ON p.target_id = f.target_id AND p.if_index = f.if_index
        WHERE f.mac = $2::macaddr`,
      [d.site_id, d.mac],
    )
  ).rows;
  return { d, location: locate(sightings) };
}

interface QuarantinePlan {
  possible: boolean;
  reason?: string;
  message?: string;
  location: PortLocation | null;
  target_id?: string;
  switch_name?: string;
  port_name?: string;
  current_vlan?: number | null;
  quarantine_vlan?: number | null;
  quarantine_vlan_source?: 'switch' | 'site' | null;
}

async function planQuarantine(db: Db, deviceId: string): Promise<QuarantinePlan & { t?: TargetRow; port?: PortFacts; d: { id: string; site_id: string; label: string } }> {
  const { d, location } = await locateForQuarantine(db, deviceId);
  const no = (reason: string, message: string, extra: Partial<QuarantinePlan> = {}) => ({ possible: false, reason, message, location, d, ...extra });
  if (!d.mac) return no('no_mac', 'The device’s MAC address is not known, so its switch port cannot be found');
  if (!location) return no('not_located', 'No switch read so far has seen this device');
  if (location.kind !== 'direct') {
    return no('not_direct', 'The device is not alone on a port (shared port or somewhere behind an uplink); quarantining that port would cut off other devices', {
      target_id: location.target_id,
      switch_name: location.switch_name,
      port_name: location.port_name,
    });
  }
  const t = await loadTarget(db, location.target_id);
  const port = await loadPort(db, t.id, location.if_index);
  const site = (await db.query<{ quarantine_vlan: number | null }>(`SELECT quarantine_vlan FROM switch_port_settings WHERE site_id = $1`, [t.site_id])).rows[0];
  const qv = t.quarantine_vlan ?? site?.quarantine_vlan ?? null;
  const base = {
    target_id: t.id,
    switch_name: t.name,
    port_name: port.name,
    current_vlan: port.access_vlan,
    quarantine_vlan: qv,
    quarantine_vlan_source: (t.quarantine_vlan ? 'switch' : site?.quarantine_vlan ? 'site' : null) as 'switch' | 'site' | null,
    t,
    port,
  };
  if (!qv) return no('no_quarantine_vlan', 'No quarantine VLAN is set for this site or switch', base);
  if (!t.write_configured) return no('write_not_configured', 'The switch’s SNMP write credentials are not entered', base);
  if (!t.vlan_methods.length || !port.mode) return no('vlans_unknown', 'The switch’s VLAN tables have not been read', base);
  if (port.mode !== 'access' || port.access_vlan === null) return no('not_access_port', 'The port is not a plain access port (as last read)', base);
  if (!(await db.query(`SELECT 1 FROM switch_vlans WHERE target_id = $1 AND vlan_id = $2`, [t.id, qv])).rowCount) {
    return no('vlan_not_found', `VLAN ${qv} is not defined on ${t.name} (as last read); create it on the switch first`, base);
  }
  if (port.access_vlan === qv) return no('already_in_quarantine_vlan', `The port is already in VLAN ${qv}`, base);
  return { possible: true, location, d, ...base };
}

const OPEN_QUARANTINE = `
  SELECT q.id, q.site_id, q.device_id, q.target_id, coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, q.if_index, q.port_name,
         q.original_vlan, q.quarantine_vlan, q.status, q.reason, q.location, q.request_id, q.release_request_id, q.last_error,
         q.created_by_email, q.created_at, q.activated_at, q.released_at, q.released_by_email,
         q.auto_release_minutes,
         coalesce((SELECT r.requested_via = 'auto_release' FROM switch_port_requests r WHERE r.id = q.release_request_id), false) AS auto_released,
         CASE WHEN q.auto_release_minutes IS NOT NULL AND q.activated_at IS NOT NULL
              THEN q.activated_at + make_interval(mins => q.auto_release_minutes) END AS auto_release_at
    FROM device_quarantines q JOIN snmp_targets t ON t.id = q.target_id`;

/** GET /devices/:id/quarantine — the current quarantine, history, and whether a quarantine is possible and why not. */
export function deviceQuarantine(req: Request, organizationId: string, deviceId: string) {
  return withTenant(organizationId, async (db) => {
    await expireStalePortRequests(db);
    const plan = await planQuarantine(db, deviceId);
    const history = (await db.query(`${OPEN_QUARANTINE} WHERE q.device_id = $1 ORDER BY q.created_at DESC LIMIT 20`, [deviceId])).rows as { status: string }[];
    const current = history.find((h) => ['requested', 'active', 'releasing'].includes(h.status)) ?? null;
    const risks = plan.possible && plan.t && plan.port ? await portRisks(db, plan.t, plan.location!.if_index, plan.port, requesterAddress(req)) : [];
    const { t: _t, port: _p, d: _d, ...view } = plan;
    return { current, history, plan: current ? { ...view, possible: false, reason: 'already_quarantined' } : view, risks, ttl_minutes: PORT_REQUEST_TTL_MINUTES };
  });
}

/** POST /devices/:id/quarantine — move the device's (own, direct) port to the quarantine VLAN. */
export function quarantineDevice(req: Request, ctx: AuthContext, deviceId: string, reason: string | undefined, releaseAfterMinutes: number | null = null) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStalePortRequests(db);
    const open = await db.query(`SELECT 1 FROM device_quarantines WHERE device_id = $1 AND status IN ('requested','active','releasing')`, [deviceId]);
    if (open.rowCount) throw new AppError(409, 'already_quarantined', 'This device is already quarantined (or its quarantine is in progress)');
    const plan = await planQuarantine(db, deviceId);
    if (!plan.possible || !plan.t || !plan.port || !plan.location) throw new AppError(409, plan.reason ?? 'not_possible', plan.message ?? 'Quarantine is not possible');
    const { t, port, location } = plan;
    const ifIndex = location.if_index;
    // Quarantine never overrides: a port that looks like an uplink or Nigafiy's own path is refused.
    const risks = await portRisks(db, t, ifIndex, port, requesterAddress(req));
    if (risks.length) throw new AppError(409, 'risky_port', 'This port looks like an uplink, a trunk or the path to Nigafiy itself; quarantine is refused', { risks });
    const qv = plan.quarantine_vlan!;
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO device_quarantines (organization_id, site_id, device_id, target_id, if_index, port_name, original_vlan, quarantine_vlan, status, reason, location, created_by, created_by_email, auto_release_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'requested',$9,$10,$11,$12,$13) RETURNING id`,
        [
          ctx.organizationId, t.site_id, deviceId, t.id, ifIndex, port.name, port.access_vlan, qv, reason || null,
          JSON.stringify({ kind: location.kind, confidence: location.confidence, evidence: location.evidence, switch_name: location.switch_name, port_name: location.port_name }),
          ctx.userId, ctx.userEmail, releaseAfterMinutes,
        ],
      )
    ).rows[0]!;
    const q = await queueChange(db, ctx, { t, ifIndex, port, change: { op: 'access_vlan', vlan: qv }, risks: [], overrideReason: null, purpose: 'quarantine', quarantineId: row.id });
    await db.query(`UPDATE device_quarantines SET request_id = $2 WHERE id = $1`, [row.id, q.request_id]);
    await audit(db, req, 'device.quarantine', { type: 'device', id: deviceId }, {
      quarantine_id: row.id,
      request_id: q.request_id,
      switch: t.name,
      port: port.name,
      from_vlan: port.access_vlan,
      to_vlan: qv,
      reason: reason || null,
      auto_release_minutes: releaseAfterMinutes,
    });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return { quarantine_id: row.id, request_id: q.request_id, expires_at: q.expires_at, status: 'requested' };
  });
}

/** POST /quarantines/:id/release — put the port back in the VLAN it was in before the quarantine. */
export function releaseQuarantine(req: Request, ctx: AuthContext, quarantineId: string) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStalePortRequests(db);
    const r = await queueRelease(db, ctx, quarantineId);
    await audit(db, req, 'device.quarantine.release', { type: 'device', id: r.device_id }, r.audit);
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return { quarantine_id: r.quarantine_id, request_id: r.request_id, expires_at: r.expires_at, status: 'releasing' };
  });
}

/** Queue the "back to the original VLAN" change of an active quarantine (by an administrator or the auto-release job). */
async function queueRelease(db: Db, ctx: PortActor, quarantineId: string) {
  const qr = (
    await db.query<{ id: string; device_id: string; target_id: string; if_index: number; status: string; original_vlan: number; quarantine_vlan: number }>(
      `SELECT id, device_id, target_id, if_index, status, original_vlan, quarantine_vlan FROM device_quarantines WHERE id = $1 FOR UPDATE`,
      [quarantineId],
    )
  ).rows[0];
  if (!qr) throw notFound('Quarantine');
  if (qr.status !== 'active') {
    throw new AppError(409, 'not_active', qr.status === 'releasing' ? 'The release is already waiting for the collector' : 'Only an active quarantine can be released');
  }
  const t = await loadTarget(db, qr.target_id, true);
  const port = await loadPort(db, t.id, qr.if_index);
  const q = await queueChange(db, ctx, {
    t,
    ifIndex: qr.if_index,
    port,
    change: { op: 'access_vlan', vlan: qr.original_vlan },
    risks: [],
    overrideReason: null,
    purpose: 'release',
    quarantineId: qr.id,
  });
  await db.query(`UPDATE device_quarantines SET status = 'releasing', release_request_id = $2, last_error = NULL WHERE id = $1`, [qr.id, q.request_id]);
  return {
    quarantine_id: qr.id,
    device_id: qr.device_id,
    request_id: q.request_id,
    expires_at: q.expires_at,
    audit: { quarantine_id: qr.id, request_id: q.request_id, switch: t.name, port: port.name, from_vlan: qr.quarantine_vlan, to_vlan: qr.original_vlan },
  };
}

/** A failed automatic release is retried after this long (the quarantine stays active meanwhile). */
export const AUTO_RELEASE_RETRY_MINUTES = 15;

/**
 * Scheduled job: release every active quarantine whose optional auto-release time (chosen by the
 * administrator when quarantining, counted from the verified move) has passed. The release is the
 * same verified VLAN change an administrator's "Release" queues, with the same checks (switch enabled
 * and in scope, write credentials, collector online, no change pending on the port); it is recorded as
 * requested by Nigafiy (requested_via 'auto_release') and audited as a system action. If it
 * cannot be queued or the collector cannot verify it, the quarantine stays active (fail closed: the
 * device stays isolated), the reason is shown, and the release is retried after
 * AUTO_RELEASE_RETRY_MINUTES.
 */
export async function runQuarantineAutoRelease(): Promise<number> {
  const due = await withSystem(async (db) =>
    (
      await db.query<{ id: string; organization_id: string; site_id: string; device_id: string }>(
        `SELECT id, organization_id, site_id, device_id FROM device_quarantines
          WHERE status = 'active' AND auto_release_minutes IS NOT NULL AND activated_at IS NOT NULL
            AND activated_at + make_interval(mins => auto_release_minutes) <= now()
            AND (auto_release_attempted_at IS NULL OR auto_release_attempted_at <= now() - make_interval(mins => $1))
          ORDER BY activated_at LIMIT 100`,
        [AUTO_RELEASE_RETRY_MINUTES],
      )
    ).rows,
  );
  let queued = 0;
  for (const d of due) {
    const actor: PortActor = { organizationId: d.organization_id, userId: null, userEmail: null, via: 'auto_release' };
    try {
      await withTenant(d.organization_id, async (db) => {
        await expireStalePortRequests(db);
        const r = await queueRelease(db, actor, d.id);
        await db.query(`UPDATE device_quarantines SET auto_release_attempted_at = now() WHERE id = $1`, [d.id]);
        await auditSystem(db, d.organization_id, {
          automation: 'quarantine_auto_release',
          action: 'device.quarantine.release',
          target: { type: 'device', id: r.device_id },
          siteId: d.site_id,
          metadata: { ...r.audit, auto_release: true },
        });
        await notifyRealtime(db, d.organization_id, 'devices');
      });
      queued += 1;
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'error';
      const message = err instanceof Error ? err.message : String(err);
      await withTenant(d.organization_id, async (db) => {
        await db.query(`UPDATE device_quarantines SET auto_release_attempted_at = now(), last_error = $2 WHERE id = $1 AND status = 'active'`, [
          d.id,
          `Automatic release not possible: ${message}`,
        ]);
        await auditSystem(db, d.organization_id, {
          automation: 'quarantine_auto_release',
          action: 'device.quarantine.auto_release_failed',
          target: { type: 'device', id: d.device_id },
          siteId: d.site_id,
          metadata: { quarantine_id: d.id, error: code, message, retry_after_minutes: AUTO_RELEASE_RETRY_MINUTES },
        });
      });
    }
  }
  return queued;
}

/**
 * Shut down the device's own switch port (ifAdminStatus down) — the playbook action
 * `switch_port_disable`. Only a port the device is alone on (located "direct") is ever touched, and
 * the same protections as a manual change apply without any override: an uplink, a trunk, a port with
 * many devices, or the path to the collector / gateway / the approving administrator's own machine is
 * refused (409 risky_port).
 */
export async function disableDevicePort(req: Request, ctx: AuthContext, deviceId: string) {
  const loc = await withTenant(ctx.organizationId, async (db) => {
    const { location } = await locateForQuarantine(db, deviceId);
    if (!location) throw new AppError(409, 'not_located', 'No switch read so far has seen this device, so its port is not known');
    if (location.kind !== 'direct') {
      throw new AppError(409, 'not_direct', 'The device is not alone on a port (shared port or behind an uplink); disabling that port would cut off other devices');
    }
    return { targetId: location.target_id, ifIndex: location.if_index };
  });
  return requestPortChange(req, ctx, loc.targetId, loc.ifIndex, { op: 'admin_status', admin_up: false, confirm: true });
}
