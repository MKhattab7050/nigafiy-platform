import type { IpamConflict } from '@lan-detective/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { type ScopeRow, SCOPES, loadFacts, planFor } from './facts.ts';

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
