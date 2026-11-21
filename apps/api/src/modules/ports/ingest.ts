import type { Db } from '../../infrastructure/db.ts';
import { type CollectorContext, ItemRejected, type SnmpPollItem } from '../../common/collector-protocol.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { portRole } from './locate.ts';
import { classifySwitchFromSnmp } from './switches/detection.ts';

const MAX_MOVE_EVENTS = 20;

interface PrevPort {
  if_index: number;
  name: string;
  oper_up: boolean;
  in_errors: string;
  out_errors: string;
  in_discards: string;
  out_discards: string;
  in_octets: string;
  out_octets: string;
  mac_count: number;
  neighbors: unknown[];
  updated_at: Date;
  oper_changed_at: Date | null;
}

/** Counter difference; null when the counter went backwards (device restarted or counter wrapped). */
function delta(now: number, before: string, also: number, alsoBefore: string): number | null {
  const d = BigInt(Math.trunc(now)) - BigInt(before) + BigInt(Math.trunc(also)) - BigInt(alsoBefore);
  return d < 0n || d > 2_000_000_000n ? null : Number(d);
}

const MAX_RATE_INTERVAL_SECONDS = 3600;

/**
 * Average bits per second between two reads of a 64-bit octet counter. Null when it cannot be
 * derived honestly: the counter went backwards (restart), the gap is too long, or the result is
 * impossible for the port's speed (a counter glitch).
 */
export function rate(now: number, before: string, seconds: number, speedMbps: number): number | null {
  if (seconds <= 0 || seconds > MAX_RATE_INTERVAL_SECONDS) return null;
  const d = BigInt(Math.trunc(now)) - BigInt(before);
  if (d < 0n) return null;
  const bps = (Number(d) * 8) / seconds;
  if (speedMbps > 0 && bps > speedMbps * 1_000_000 * 1.1) return null;
  return bps;
}

/** Stores one read of a switch: status, ports (with change since the last read) and the forwarding table. */
export async function processSnmpPoll(db: Db, c: CollectorContext, item: SnmpPollItem): Promise<void> {
  const at = new Date(item.ts);
  const target = (
    await db.query<{ id: string; site_id: string; name: string | null; host: string; last_status: string; device_id: string | null; last_ok_at: Date | null }>(
      `SELECT id, site_id, name, host(host) AS host, last_status, device_id, last_ok_at FROM snmp_targets WHERE id = $1 AND site_id = $2 FOR UPDATE`,
      [item.target_id, c.siteId],
    )
  ).rows[0];
  if (!target) throw new ItemRejected('snmp_poll for a switch that is not configured for this collector’s site');
  const label = target.name ?? item.sys_name ?? target.host;

  if (!item.ok) {
    await db.query(`UPDATE snmp_targets SET last_polled_at = $2, last_status = 'error', last_error = $3 WHERE id = $1`, [target.id, at, item.error ?? 'read failed']);
    if (target.last_status === 'ok') {
      await emitEvent(db, c.organizationId, {
        siteId: c.siteId,
        deviceId: target.device_id,
        collectorId: c.id,
        type: 'switch_unreadable',
        severity: 'warning',
        title: `Switch ${label} stopped answering SNMP`,
        details: { host: target.host, error: item.error ?? null, note: 'Port information is as of the last successful read.' },
        source: 'collector',
        occurredAt: at,
      });
    }
    await notifyRealtime(db, c.organizationId, 'devices');
    return;
  }

  const ports = item.ports ?? [];
  const fdb = item.fdb ?? [];
  const lldp = item.lldp ?? [];

  const prevPorts = new Map(
    (
      await db.query<PrevPort>(
        `SELECT if_index, name, oper_up, in_errors::text, out_errors::text, in_discards::text, out_discards::text, in_octets::text, out_octets::text, mac_count, neighbors, updated_at, oper_changed_at
           FROM switch_ports WHERE target_id = $1`,
        [target.id],
      )
    ).rows.map((p) => [p.if_index, p]),
  );
  const prevFdb = new Map(
    (await db.query<{ mac: string; if_index: number }>(`SELECT mac::text AS mac, if_index FROM switch_fdb WHERE target_id = $1`, [target.id])).rows.map((r) => [r.mac, r.if_index]),
  );

  const macCount = new Map<number, Set<string>>();
  for (const e of fdb) {
    const set = macCount.get(e.if_index) ?? new Set();
    set.add(e.mac.toLowerCase());
    macCount.set(e.if_index, set);
  }
  const neighborsOf = new Map<number, unknown[]>();
  for (const n of lldp) {
    const { if_index, ...rest } = n;
    neighborsOf.set(if_index, [...(neighborsOf.get(if_index) ?? []), rest]);
  }

  const sampleIfIndex: number[] = [];
  const sampleSeconds: number[] = [];
  const sampleInBps: (number | null)[] = [];
  const sampleOutBps: (number | null)[] = [];
  const sampleErrors: (number | null)[] = [];
  const sampleDiscards: (number | null)[] = [];
  const sampleOperUp: boolean[] = [];

  const portIfIndex: number[] = [];
  const portNameArr: string[] = [];
  const portDescr: (string | null)[] = [];
  const portAlias: (string | null)[] = [];
  const portAdminUp: boolean[] = [];
  const portOperUp: boolean[] = [];
  const portSpeedMbps: number[] = [];
  const portInErrors: number[] = [];
  const portOutErrors: number[] = [];
  const portInDiscards: number[] = [];
  const portOutDiscards: number[] = [];
  const portInOctets: number[] = [];
  const portOutOctets: number[] = [];
  const portErrorsDelta: (number | null)[] = [];
  const portDiscardsDelta: (number | null)[] = [];
  const portDeltaSeconds: (number | null)[] = [];
  const portMacCount: number[] = [];
  const portNeighbors: string[] = [];
  const portOperChangedAt: (Date | null)[] = [];
  const portInBps: (number | null)[] = [];
  const portOutBps: (number | null)[] = [];

  for (const p of ports) {
    const prev = prevPorts.get(p.if_index);
    const seconds = prev ? Math.round((at.getTime() - prev.updated_at.getTime()) / 1000) : null;
    const fresh = prev && seconds !== null && seconds > 0;
    const errorsDelta = fresh ? delta(p.in_errors, prev.in_errors, p.out_errors, prev.out_errors) : null;
    const discardsDelta = fresh ? delta(p.in_discards, prev.in_discards, p.out_discards, prev.out_discards) : null;
    const inBps = fresh ? rate(p.in_octets, prev.in_octets, seconds, p.speed_mbps) : null;
    const outBps = fresh ? rate(p.out_octets, prev.out_octets, seconds, p.speed_mbps) : null;
    // History: one sample per read for ports that are (or just were) up. Idle down ports add nothing.
    if (fresh && (p.oper_up || prev.oper_up)) {
      sampleIfIndex.push(p.if_index);
      sampleSeconds.push(seconds);
      sampleInBps.push(inBps);
      sampleOutBps.push(outBps);
      sampleErrors.push(errorsDelta);
      sampleDiscards.push(discardsDelta);
      sampleOperUp.push(p.oper_up);
    }
    portIfIndex.push(p.if_index);
    portNameArr.push(p.name);
    portDescr.push(p.descr ?? null);
    portAlias.push(p.alias || null);
    portAdminUp.push(p.admin_up);
    portOperUp.push(p.oper_up);
    portSpeedMbps.push(p.speed_mbps);
    portInErrors.push(p.in_errors);
    portOutErrors.push(p.out_errors);
    portInDiscards.push(p.in_discards);
    portOutDiscards.push(p.out_discards);
    portInOctets.push(p.in_octets);
    portOutOctets.push(p.out_octets);
    portErrorsDelta.push(errorsDelta);
    portDiscardsDelta.push(discardsDelta);
    portDeltaSeconds.push(fresh ? seconds : null);
    portMacCount.push(macCount.get(p.if_index)?.size ?? 0);
    portNeighbors.push(JSON.stringify(neighborsOf.get(p.if_index) ?? []));
    portOperChangedAt.push(prev ? (prev.oper_up === p.oper_up ? prev.oper_changed_at : at) : null);
    portInBps.push(inBps);
    portOutBps.push(outBps);
  }

  if (sampleIfIndex.length > 0) {
    await db.query(
      `INSERT INTO switch_port_samples (target_id, if_index, ts, organization_id, seconds, in_bps, out_bps, errors, discards, oper_up)
       SELECT $1, u.if_index, $2, $3, u.seconds, u.in_bps, u.out_bps, u.errors, u.discards, u.oper_up
         FROM unnest($4::int[], $5::int[], $6::float8[], $7::float8[], $8::int[], $9::int[], $10::boolean[])
              AS u(if_index, seconds, in_bps, out_bps, errors, discards, oper_up)
       ON CONFLICT DO NOTHING`,
      [target.id, at, c.organizationId, sampleIfIndex, sampleSeconds, sampleInBps, sampleOutBps, sampleErrors, sampleDiscards, sampleOperUp],
    );
  }

  if (ports.length > 0) {
    await db.query(
      `INSERT INTO switch_ports (target_id, if_index, organization_id, name, descr, alias, admin_up, oper_up, speed_mbps, in_errors, out_errors, in_discards,
                                 out_discards, in_octets, out_octets, errors_delta, discards_delta, delta_seconds, mac_count, neighbors, oper_changed_at, updated_at, in_bps, out_bps)
       SELECT $1, u.if_index, $2, u.name, u.descr, u.alias, u.admin_up, u.oper_up, u.speed_mbps, u.in_errors, u.out_errors, u.in_discards,
              u.out_discards, u.in_octets, u.out_octets, u.errors_delta, u.discards_delta, u.delta_seconds, u.mac_count, u.neighbors, u.oper_changed_at, $3, u.in_bps, u.out_bps
         FROM unnest($4::int[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::boolean[], $10::bigint[], $11::numeric[], $12::numeric[], $13::numeric[],
                     $14::numeric[], $15::numeric[], $16::numeric[], $17::bigint[], $18::bigint[], $19::int[], $20::int[], $21::jsonb[], $22::timestamptz[], $23::float8[], $24::float8[])
              AS u(if_index, name, descr, alias, admin_up, oper_up, speed_mbps, in_errors, out_errors, in_discards,
                   out_discards, in_octets, out_octets, errors_delta, discards_delta, delta_seconds, mac_count, neighbors, oper_changed_at, in_bps, out_bps)
       ON CONFLICT (target_id, if_index) DO UPDATE SET
         name = EXCLUDED.name, descr = EXCLUDED.descr, alias = EXCLUDED.alias, admin_up = EXCLUDED.admin_up, oper_up = EXCLUDED.oper_up,
         speed_mbps = EXCLUDED.speed_mbps, in_errors = EXCLUDED.in_errors, out_errors = EXCLUDED.out_errors, in_discards = EXCLUDED.in_discards,
         out_discards = EXCLUDED.out_discards, in_octets = EXCLUDED.in_octets, out_octets = EXCLUDED.out_octets, errors_delta = EXCLUDED.errors_delta,
         discards_delta = EXCLUDED.discards_delta, delta_seconds = EXCLUDED.delta_seconds, mac_count = EXCLUDED.mac_count, neighbors = EXCLUDED.neighbors,
         oper_changed_at = EXCLUDED.oper_changed_at, updated_at = EXCLUDED.updated_at, in_bps = EXCLUDED.in_bps, out_bps = EXCLUDED.out_bps`,
      [
        target.id,
        c.organizationId,
        at,
        portIfIndex,
        portNameArr,
        portDescr,
        portAlias,
        portAdminUp,
        portOperUp,
        portSpeedMbps,
        portInErrors,
        portOutErrors,
        portInDiscards,
        portOutDiscards,
        portInOctets,
        portOutOctets,
        portErrorsDelta,
        portDiscardsDelta,
        portDeltaSeconds,
        portMacCount,
        portNeighbors,
        portOperChangedAt,
        portInBps,
        portOutBps,
      ],
    );
  }
  if (item.ports !== undefined) {
    await db.query(`DELETE FROM switch_ports WHERE target_id = $1 AND NOT (if_index = ANY($2::int[]))`, [target.id, ports.map((p) => p.if_index)]);
  }

  // Forwarding table: upsert what was read, then drop what is no longer there.
  if (fdb.length) {
    await db.query(
      `INSERT INTO switch_fdb (target_id, mac, vlan, organization_id, if_index, first_seen_at, last_seen_at)
       SELECT $1, m::macaddr, v, $2, i, $3, $3 FROM unnest($4::text[], $5::int[], $6::int[]) AS x(m, v, i)
       ON CONFLICT (target_id, mac, vlan) DO UPDATE SET if_index = EXCLUDED.if_index, last_seen_at = EXCLUDED.last_seen_at`,
      [target.id, c.organizationId, at, fdb.map((e) => e.mac.toLowerCase()), fdb.map((e) => e.vlan), fdb.map((e) => e.if_index)],
    );
  }
  if (item.fdb !== undefined) {
    await db.query(`DELETE FROM switch_fdb WHERE target_id = $1 AND last_seen_at < $2`, [target.id, at]);
  }

  await db.query(
    `UPDATE snmp_targets
        SET last_polled_at = $2, last_ok_at = $2, last_status = 'ok', last_error = NULL, sys_name = $3, sys_descr = $4, truncated = $5,
            device_id = coalesce(device_id, (SELECT d.id FROM devices d WHERE d.site_id = $6 AND d.current_ip = snmp_targets.host ORDER BY d.last_seen_at DESC LIMIT 1))
      WHERE id = $1`,
    [target.id, at, item.sys_name ?? null, item.sys_descr ?? null, item.truncated ?? [], c.siteId],
  );

  if (target.last_ok_at === null) {
    await classifySwitchFromSnmp(db, c, target.id, label, {
      sysName: item.sys_name ?? null,
      sysDescr: item.sys_descr ?? null,
      ports: ports.length,
      addresses: fdb.length,
    });
  }

  if (target.last_status === 'error') {
    await emitEvent(db, c.organizationId, {
      siteId: c.siteId,
      deviceId: target.device_id,
      collectorId: c.id,
      type: 'switch_readable',
      severity: 'info',
      title: `Switch ${label} answers SNMP again`,
      details: { host: target.host, ports: ports.length, addresses: fdb.length },
      source: 'collector',
      occurredAt: at,
    });
  }

  // A known device that moved from one access port to another. Trunks and uplinks are ignored:
  // addresses legitimately come and go on them.
  const isAccess = (ifIndex: number, count: number, neighbors: unknown[]) => {
    const role = portRole({ oper_up: true, mac_count: count, neighbors });
    return (role === 'edge' || role === 'shared') && ifIndex > 0;
  };
  const portName = new Map(ports.map((p) => [p.if_index, p.name]));
  const moved = fdb.filter((e) => {
    const before = prevFdb.get(e.mac.toLowerCase());
    if (before === undefined || before === e.if_index) return false;
    const prev = prevPorts.get(before);
    return (
      prev !== undefined &&
      isAccess(before, prev.mac_count, prev.neighbors) &&
      isAccess(e.if_index, macCount.get(e.if_index)?.size ?? 0, neighborsOf.get(e.if_index) ?? [])
    );
  });
  if (moved.length) {
    const devices = new Map(
      (
        await db.query<{ id: string; mac: string; label: string }>(
          `SELECT id, primary_mac::text AS mac, coalesce(display_name, hostname, host(current_ip), primary_mac::text) AS label
             FROM devices WHERE site_id = $1 AND primary_mac = ANY($2::macaddr[])`,
          [c.siteId, moved.map((e) => e.mac.toLowerCase())],
        )
      ).rows.map((d) => [d.mac, d]),
    );
    let emitted = 0;
    for (const e of moved) {
      const dev = devices.get(e.mac.toLowerCase());
      if (!dev || emitted >= MAX_MOVE_EVENTS) continue;
      const from = prevPorts.get(prevFdb.get(e.mac.toLowerCase())!)!.name;
      const to = portName.get(e.if_index) ?? `if${e.if_index}`;
      await emitEvent(db, c.organizationId, {
        siteId: c.siteId,
        deviceId: dev.id,
        collectorId: c.id,
        type: 'device_port_changed',
        severity: 'info',
        title: `${dev.label} moved from port ${from} to ${to} on ${label}`,
        details: { switch: label, switch_host: target.host, mac: e.mac.toLowerCase(), from_port: from, to_port: to, source: 'switch forwarding table (SNMP)' },
        source: 'collector',
        occurredAt: at,
      });
      emitted++;
    }
  }
  await notifyRealtime(db, c.organizationId, 'devices');
}
