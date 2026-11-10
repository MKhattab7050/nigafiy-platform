import type { DeviceStatus } from '@lan-detective/shared-types';
import { cidrContains, isLocallyAdministeredMac, normalizeMac, vendorForMac } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';
import type { Fingerprint } from '../devices/classify.ts';
import { applyIdentification } from '../devices/identify.ts';
import { emitEvent } from '../events/emit.ts';
import { type CollectorContext, type DiscoveryRunItem, ItemRejected, MAX_FUTURE_SKEW_MS } from './schema.ts';

/** A device is declared offline only after it was absent from this many consecutive sweeps of its scope. */
export const OFFLINE_AFTER_MISSED_SWEEPS = 2;

interface DeviceRow {
  id: string;
  mac: string | null;
  ip: string | null;
  status: DeviceStatus;
  hostname: string | null;
  display_name: string | null;
  is_critical: boolean;
  discovery_sources: string[];
  last_seen_at: Date;
}

interface Identity {
  mac: string | null;
  ips: string[];
  hostname: string | null;
  sources: Set<string>;
  fingerprint: Fingerprint;
}

const ipToInt = (ip: string): number => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
const deviceLabel = (d: { display_name?: string | null; hostname?: string | null; ip?: string | null; mac?: string | null }): string =>
  d.display_name || d.hostname || d.ip || d.mac || 'Device';

async function setAvailability(db: Db, organizationId: string, deviceIds: string[], status: DeviceStatus, at: Date): Promise<void> {
  if (deviceIds.length === 0) return;
  await db.query(`UPDATE availability_history SET ended_at = $2 WHERE device_id = ANY($1) AND ended_at IS NULL`, [deviceIds, at]);
  await db.query(
    `INSERT INTO availability_history (organization_id, device_id, status, started_at) SELECT $1, unnest($2::uuid[]), $3, $4`,
    [organizationId, deviceIds, status, at],
  );
}

/**
 * Apply one discovery sweep of one authorized scope.
 *
 * Identity rules (see docs/architecture/overview.md §Device identity):
 *  - a MAC address identifies a device within a site and follows it across IP changes;
 *  - when no MAC could be observed, the IP address is the identity and the device is marked as such;
 *  - a host seen without a MAC is matched to the device currently holding that IP.
 * Everything written here is an observation with a timestamp and a source — nothing is guessed.
 */
export async function processDiscoveryRun(db: Db, c: CollectorContext, item: DiscoveryRunItem, now: Date): Promise<void> {
  const scopeResult = await db.query<{ id: string; cidr: string; last_run_finished_at: Date | null }>(
    `SELECT id, cidr::text AS cidr, last_run_finished_at FROM network_scopes WHERE id = $1 AND site_id = $2 AND enabled FOR UPDATE`,
    [item.scope_id, c.siteId],
  );
  const scope = scopeResult.rows[0];
  if (!scope) throw new ItemRejected('scope is unknown, disabled, or not part of this collector\'s site');

  const startedAt = new Date(item.started_at);
  const finishedAt = new Date(item.finished_at);
  if (finishedAt < startedAt) throw new ItemRejected('finished_at is before started_at');
  if (finishedAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) throw new ItemRejected('timestamp is in the future');

  // Group observations into identities. Hosts outside the authorized scope are dropped and counted.
  const byIp = new Map<string, (typeof item.hosts)[number]>();
  let rejectedHosts = 0;
  for (const host of item.hosts) {
    if (!cidrContains(scope.cidr, host.ip)) {
      rejectedHosts++;
      continue;
    }
    const existing = byIp.get(host.ip);
    if (!existing || (!existing.mac && host.mac)) byIp.set(host.ip, host);
  }
  const identities = new Map<string, Identity>();
  for (const host of byIp.values()) {
    let mac = host.mac ? normalizeMac(host.mac) : null;
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') mac = null;
    const key = mac ?? `ip:${host.ip}`;
    const identity = identities.get(key) ?? { mac, ips: [], hostname: null, sources: new Set<string>(), fingerprint: {} };
    if (host.names) identity.fingerprint.names = [...(identity.fingerprint.names ?? []), ...host.names];
    if (host.services) identity.fingerprint.services = [...(identity.fingerprint.services ?? []), ...host.services];
    if (host.hints) identity.fingerprint.hints = { ...identity.fingerprint.hints, ...host.hints };
    if (host.ssdp) identity.fingerprint.ssdp = host.ssdp;
    identity.ips.push(host.ip);
    identity.hostname ??= host.hostname ?? null;
    for (const s of host.sources) identity.sources.add(s);
    identities.set(key, identity);
  }

  const stale = scope.last_run_finished_at !== null && finishedAt <= scope.last_run_finished_at;
  const baseline = scope.last_run_finished_at === null;

  const run = await db.query(
    `INSERT INTO discovery_runs (collector_id, run_id, organization_id, site_id, scope_id, cidr, trigger, started_at, finished_at,
                                 hosts_probed, hosts_responded, hosts_rejected, applied)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [c.id, item.run_id, c.organizationId, c.siteId, scope.id, scope.cidr, item.trigger, startedAt, finishedAt, item.hosts_probed, byIp.size, rejectedHosts, !stale],
  );
  if (run.rowCount === 0) return; // this exact run was already ingested
  // A late (buffered) sweep older than what we already applied is kept as history only:
  // it must not overwrite the current picture of the network.
  if (stale) return;

  const macs = [...identities.values()].flatMap((i) => (i.mac ? [i.mac] : []));
  const loaded = await db.query<DeviceRow>(
    `SELECT id, primary_mac::text AS mac, host(current_ip) AS ip, status, hostname, display_name, is_critical, discovery_sources, last_seen_at
       FROM devices
      WHERE site_id = $1 AND (primary_mac = ANY($2::macaddr[]) OR current_ip <<= $3::cidr)
      ORDER BY last_seen_at DESC
      FOR UPDATE`,
    [c.siteId, macs, scope.cidr],
  );
  const deviceByMac = new Map<string, DeviceRow>();
  const devicesByIp = new Map<string, DeviceRow[]>();
  for (const d of loaded.rows) {
    if (d.mac) deviceByMac.set(d.mac, d);
    if (d.ip) devicesByIp.set(d.ip, [...(devicesByIp.get(d.ip) ?? []), d]);
  }

  const claimed = new Set<string>();
  const seenExisting: string[] = [];
  const historyDeviceIds: string[] = [];
  const historyIps: string[] = [];
  const cameOnline: string[] = [];
  const identified = new Map<string, Fingerprint>(); // device id → what it announced this sweep
  const collectorHosts = new Set<string>(); // device ids that are the collector's own host
  let created = 0;

  for (const identity of identities.values()) {
    identity.ips.sort((a, b) => ipToInt(a) - ipToInt(b));
    let device = identity.mac ? deviceByMac.get(identity.mac) : undefined;
    let previousHolder: DeviceRow | undefined;

    if (!device) {
      for (const ip of identity.ips) {
        for (const candidate of devicesByIp.get(ip) ?? []) {
          if (claimed.has(candidate.id)) continue;
          if (!identity.mac || !candidate.mac) {
            device = candidate;
            break;
          }
          // Same IP, different MAC, and the other device was online at the last sweep → worth showing.
          if (candidate.status === 'online') previousHolder ??= candidate;
        }
        if (device) break;
      }
      if (device && identity.mac && !device.mac) {
        // We knew this address without a MAC; now a MAC is observable. Upgrade the identity.
        await db.query(
          `UPDATE devices SET primary_mac = $2, identity_basis = 'mac', mac_randomized = $3, vendor = coalesce(vendor, $4) WHERE id = $1`,
          [device.id, identity.mac, isLocallyAdministeredMac(identity.mac), vendorForMac(identity.mac)],
        );
        device.mac = identity.mac;
        deviceByMac.set(identity.mac, device);
      }
    }

    const chosenIp = device?.ip && identity.ips.includes(device.ip) ? device.ip : identity.ips[0]!;
    const sources = [...identity.sources].sort();

    if (!device) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO devices (organization_id, site_id, identity_basis, primary_mac, mac_randomized, current_ip, hostname, vendor,
                              status, discovery_sources, first_seen_at, last_seen_at, name_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'online',$9,$10,$10, CASE WHEN $7::text IS NULL THEN NULL ELSE 'rdns' END) RETURNING id`,
        [
          c.organizationId,
          c.siteId,
          identity.mac ? 'mac' : 'ip',
          identity.mac,
          identity.mac ? isLocallyAdministeredMac(identity.mac) : false,
          chosenIp,
          identity.hostname,
          identity.mac ? vendorForMac(identity.mac) : null,
          sources,
          finishedAt,
        ],
      );
      const id = inserted.rows[0]!.id;
      created++;
      identified.set(id, identity.fingerprint);
      if (identity.sources.has('local_interface')) collectorHosts.add(id);
      claimed.add(id);
      await db.query(`INSERT INTO availability_history (organization_id, device_id, status, started_at) VALUES ($1,$2,'online',$3)`, [c.organizationId, id, finishedAt]);
      for (const ip of identity.ips) {
        historyDeviceIds.push(id);
        historyIps.push(ip);
      }
      // The first sweep of a scope establishes the baseline: one summary event instead of hundreds.
      if (!baseline) {
        await emitEvent(db, c.organizationId, {
          siteId: c.siteId,
          deviceId: id,
          collectorId: c.id,
          type: 'device_discovered',
          severity: 'info',
          title: `New device on the network: ${deviceLabel({ hostname: identity.hostname, ip: chosenIp, mac: identity.mac })}`,
          details: {
            ip: chosenIp,
            mac: identity.mac,
            mac_randomized: identity.mac ? isLocallyAdministeredMac(identity.mac) : null,
            vendor: identity.mac ? vendorForMac(identity.mac) : null,
            hostname: identity.hostname,
            observed_via: sources,
            scope: scope.cidr,
          },
          source: 'collector',
          occurredAt: finishedAt,
        });
      }
      if (previousHolder && identity.mac) {
        await emitEvent(db, c.organizationId, {
          siteId: c.siteId,
          deviceId: id,
          collectorId: c.id,
          type: 'ip_mac_changed',
          severity: 'warning',
          title: `${chosenIp} is now answered by a different MAC address`,
          details: {
            ip: chosenIp,
            previous_mac: previousHolder.mac,
            previous_device_id: previousHolder.id,
            previous_last_seen_at: previousHolder.last_seen_at,
            new_mac: identity.mac,
            observed_via: sources,
            interpretation:
              'Observed fact only. Common benign causes: DHCP lease reassigned, hardware replaced, MAC randomization. It can also indicate an IP conflict or ARP spoofing — compare with the previous device.',
          },
          source: 'collector',
          occurredAt: finishedAt,
        });
      }
      continue;
    }

    claimed.add(device.id);
    seenExisting.push(device.id);
    identified.set(device.id, identity.fingerprint);
    if (identity.sources.has('local_interface')) collectorHosts.add(device.id);
    for (const ip of identity.ips) {
      historyDeviceIds.push(device.id);
      historyIps.push(ip);
    }

    if (device.ip !== chosenIp) {
      await db.query(`UPDATE devices SET current_ip = $2 WHERE id = $1`, [device.id, chosenIp]);
      await emitEvent(db, c.organizationId, {
        siteId: c.siteId,
        deviceId: device.id,
        collectorId: c.id,
        type: 'device_ip_changed',
        severity: 'info',
        title: `${deviceLabel(device)} changed IP address: ${device.ip ?? 'none'} → ${chosenIp}`,
        details: { mac: device.mac, previous_ip: device.ip, new_ip: chosenIp, observed_via: sources },
        source: 'collector',
        occurredAt: finishedAt,
      });
    }
    if (identity.hostname && identity.hostname !== device.hostname) {
      await db.query(`UPDATE devices SET hostname = $2, name_source = 'rdns' WHERE id = $1`, [device.id, identity.hostname]);
    }
    const knownSources = device.discovery_sources;
    if (sources.some((s) => !knownSources.includes(s))) {
      await db.query(`UPDATE devices SET discovery_sources = $2 WHERE id = $1`, [device.id, [...new Set([...knownSources, ...sources])].sort()]);
    }
    if (device.status !== 'online') {
      cameOnline.push(device.id);
      if (device.status === 'offline') {
        await emitEvent(db, c.organizationId, {
          siteId: c.siteId,
          deviceId: device.id,
          collectorId: c.id,
          type: 'device_online',
          severity: 'info',
          title: `${deviceLabel(device)} is back online`,
          details: { ip: chosenIp, mac: device.mac, previously_last_seen_at: device.last_seen_at, observed_via: sources },
          source: 'collector',
          occurredAt: finishedAt,
        });
      }
    }
  }

  if (seenExisting.length) {
    await db.query(`UPDATE devices SET last_seen_at = $2, missed_sweeps = 0, status = 'online' WHERE id = ANY($1)`, [seenExisting, finishedAt]);
  }
  await setAvailability(db, c.organizationId, cameOnline, 'online', finishedAt);
  if (historyIps.length) {
    await db.query(
      `INSERT INTO device_ip_history (device_id, organization_id, ip, first_seen_at, last_seen_at)
       SELECT d, $1, i::inet, $4, $4 FROM unnest($2::uuid[], $3::text[]) AS t(d, i)
       ON CONFLICT (device_id, ip) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [c.organizationId, historyDeviceIds, historyIps, finishedAt],
    );
  }

  // Devices of this scope that did not answer this sweep.
  const missing = loaded.rows.filter((d) => !claimed.has(d.id) && d.status !== 'offline' && d.ip && cidrContains(scope.cidr, d.ip));
  if (missing.length) {
    const counted = await db.query<{ id: string; missed_sweeps: number }>(
      `UPDATE devices SET missed_sweeps = missed_sweeps + 1 WHERE id = ANY($1) RETURNING id, missed_sweeps`,
      [missing.map((d) => d.id)],
    );
    const missedById = new Map(counted.rows.map((r) => [r.id, r.missed_sweeps]));
    const goneOffline = missing.filter((d) => (missedById.get(d.id) ?? 0) >= OFFLINE_AFTER_MISSED_SWEEPS);
    if (goneOffline.length) {
      const ids = goneOffline.map((d) => d.id);
      await db.query(`UPDATE devices SET status = 'offline' WHERE id = ANY($1)`, [ids]);
      await setAvailability(db, c.organizationId, ids, 'offline', finishedAt);
      for (const d of goneOffline) {
        await emitEvent(db, c.organizationId, {
          siteId: c.siteId,
          deviceId: d.id,
          collectorId: c.id,
          type: 'device_offline',
          // Laptops and phones leave all day; only devices marked critical raise a critical alert.
          severity: d.is_critical ? 'critical' : 'info',
          title: `${deviceLabel(d)} stopped responding`,
          details: {
            ip: d.ip,
            mac: d.mac,
            last_seen_at: d.last_seen_at,
            consecutive_missed_sweeps: missedById.get(d.id),
            scope: scope.cidr,
            method: 'No ICMP echo reply and no neighbour (ARP) table entry on the collector host',
            limitation: 'A device that is powered on but silent to both ICMP and ARP from the collector would also look like this.',
          },
          source: 'collector',
          occurredAt: finishedAt,
        });
      }
    }
  }

  await db.query(`UPDATE network_scopes SET last_run_finished_at = $2 WHERE id = $1`, [scope.id, finishedAt]);

  // Name and classify what was seen, from what the devices announced (never overrides a manual choice).
  await applyIdentification(db, identified, { ip: c.gatewayIp, collector: c.name }, { ids: collectorHosts, os: c.os, hostname: c.hostname });

  if (baseline) {
    await emitEvent(db, c.organizationId, {
      siteId: c.siteId,
      collectorId: c.id,
      type: 'discovery_baseline',
      severity: 'info',
      title: `Initial discovery of ${scope.cidr} found ${created} device${created === 1 ? '' : 's'}`,
      details: { scope: scope.cidr, hosts_probed: item.hosts_probed, devices_found: created, started_at: startedAt, finished_at: finishedAt },
      source: 'collector',
      occurredAt: finishedAt,
    });
  }
}
