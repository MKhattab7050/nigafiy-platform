import type { Confidence } from '@nigafiy/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { type Fingerprint, bestName, classify, mergeFingerprint } from './classify.ts';

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

interface Row {
  id: string;
  ip: string | null;
  hostname: string | null;
  name_source: string | null;
  vendor: string | null;
  mac_randomized: boolean;
  device_type: string;
  type_source: 'none' | 'inferred' | 'manual';
  type_confidence: Confidence | null;
  type_evidence: string | null;
  fingerprint: Fingerprint;
}

/**
 * After a sweep: store what each seen device said about itself, name it if it has no better
 * name, and (re)classify it. A manual classification is never touched, and an inferred one is
 * only replaced by a result that is at least as confident.
 */
const OS_TYPE: Record<string, 'windows_computer' | 'linux_computer' | 'apple_computer'> = { windows: 'windows_computer', linux: 'linux_computer', darwin: 'apple_computer' };

export async function applyIdentification(
  db: Db,
  seen: Map<string, Fingerprint>,
  gateway: { ip: string | null; collector: string },
  collectorHost: { ids: Set<string>; os: string | null; hostname: string | null } = { ids: new Set(), os: null, hostname: null },
): Promise<void> {
  if (seen.size === 0) return;
  const rows = await db.query<Row>(
    `SELECT id, host(current_ip) AS ip, hostname, name_source, vendor, mac_randomized, device_type, type_source, type_confidence, type_evidence, fingerprint
       FROM devices WHERE id = ANY($1)`,
    [[...seen.keys()]],
  );
  for (const d of rows.rows) {
    const fingerprint = mergeFingerprint(d.fingerprint ?? {}, seen.get(d.id) ?? {});
    const sets: string[] = [];
    const values: unknown[] = [d.id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (JSON.stringify(fingerprint) !== JSON.stringify(d.fingerprint ?? {})) set('fingerprint', JSON.stringify(fingerprint));

    let hostname = d.hostname;
    // Reverse DNS stays authoritative when present; otherwise use the name the device announces.
    const announced = bestName(fingerprint);
    if (announced && (!d.hostname || (d.name_source !== 'rdns' && d.hostname !== announced.name))) {
      hostname = announced.name;
      set('hostname', announced.name);
      set('name_source', announced.source);
    }

    if (d.type_source !== 'manual') {
      // The machine the collector runs on is known first-hand: the collector reports its own OS.
      const own = collectorHost.ids.has(d.id) && collectorHost.os ? OS_TYPE[collectorHost.os] : undefined;
      const result = own
        ? { type: own, confidence: 'high' as const, evidence: [`This is the machine running collector "${gateway.collector}", which reports its operating system as ${collectorHost.os}`] }
        : classify({ fingerprint, hostname, vendor: d.vendor, macRandomized: d.mac_randomized, gatewayOf: gateway.ip && d.ip === gateway.ip ? gateway.collector : null });
      if (own && !hostname && collectorHost.hostname) {
        set('hostname', collectorHost.hostname);
        set('name_source', 'collector');
      }
      if (result) {
        const evidence = result.evidence.join(' · ');
        const weaker = d.type_source === 'inferred' && d.type_confidence !== null && RANK[result.confidence] < RANK[d.type_confidence];
        if (!weaker && (d.device_type !== result.type || d.type_confidence !== result.confidence || d.type_evidence !== evidence)) {
          set('device_type', result.type);
          set('type_source', 'inferred');
          set('type_confidence', result.confidence);
          set('type_evidence', evidence);
        }
      }
    }
    if (sets.length) await db.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $1`, values);
  }
}

/**
 * Return a device's type to automatic: forget the manual type and classify it again right away from
 * the evidence already stored (what it announced, its vendor, whether a collector uses it as gateway).
 * With no evidence it is "unknown" until the next sweep brings some.
 */
export async function resetDeviceType(db: Db, deviceId: string): Promise<boolean> {
  const d = (
    await db.query<Row & { site_id: string }>(
      `SELECT id, site_id, host(current_ip) AS ip, hostname, name_source, vendor, mac_randomized, device_type, type_source, type_confidence, type_evidence, fingerprint
         FROM devices WHERE id = $1 FOR UPDATE`,
      [deviceId],
    )
  ).rows[0];
  if (!d) return false;
  const gatewayOf = d.ip
    ? ((
        await db.query<{ name: string }>(
          `SELECT name FROM collectors WHERE site_id = $1 AND status = 'active' AND gateway_ip = $2::inet ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1`,
          [d.site_id, d.ip],
        )
      ).rows[0]?.name ?? null)
    : null;
  const result = classify({ fingerprint: d.fingerprint ?? {}, hostname: d.hostname, vendor: d.vendor, macRandomized: d.mac_randomized, gatewayOf });
  await db.query(`UPDATE devices SET device_type = $2, type_source = $3, type_confidence = $4, type_evidence = $5 WHERE id = $1`, [
    deviceId,
    result?.type ?? 'unknown',
    result ? 'inferred' : 'none',
    result?.confidence ?? null,
    result ? result.evidence.join(' · ') : null,
  ]);
  return true;
}
