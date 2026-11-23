import type { Confidence, DeviceType, SwitchCandidate, SwitchCandidateReason } from '@nigafiy/shared-types';
import { auditSystem } from '../../../common/audit.ts';
import type { CollectorContext } from '../../../common/collector-protocol.ts';
import { notFound } from '../../../common/http.ts';
import { type Db, withTenant } from '../../../infrastructure/db.ts';
import { logger } from '../../../infrastructure/logger.ts';
import { automationEnabled } from '../../automation/index.ts';

// Switch detection. Two directions, neither of which ever touches SNMP credentials:
//   - after a switch's first successful SNMP read, its linked device is marked a switch (automation
//     `classify.switch_from_snmp`; a manual type is never overridden);
//   - devices that probably are switches but are not read yet are listed for the user to add.

const KEY = 'classify.switch_from_snmp';

/**
 * Called once per switch, on its first successful SNMP read. Isolated in a savepoint so that a
 * failure here can never reject the poll itself.
 */
export async function classifySwitchFromSnmp(
  db: Db,
  c: CollectorContext,
  targetId: string,
  label: string,
  facts: { sysName: string | null; sysDescr: string | null; ports: number; addresses: number },
): Promise<void> {
  await db.query('SAVEPOINT classify_switch');
  try {
    const device = (
      await db.query<{ id: string; device_type: DeviceType; type_source: 'none' | 'inferred' | 'manual'; type_confidence: Confidence | null }>(
        `SELECT d.id, d.device_type, d.type_source, d.type_confidence
           FROM snmp_targets t JOIN devices d ON d.id = t.device_id
          WHERE t.organization_id = $1 AND t.id = $2 FOR UPDATE OF d`,
        [c.organizationId, targetId],
      )
    ).rows[0];
    const applies =
      device &&
      device.type_source !== 'manual' &&
      !(device.device_type === 'switch' && device.type_confidence === 'high') &&
      (await automationEnabled(db, c.organizationId, c.siteId, KEY));
    if (applies) {
      const evidence = [
        `Added in Port Detective as a switch and answered its first SNMP read (collector "${c.name}")`,
        facts.sysName && `SNMP sysName "${facts.sysName}"`,
        `${facts.ports} interface(s) and a forwarding table with ${facts.addresses} address(es)`,
        facts.sysDescr && `SNMP sysDescr "${facts.sysDescr.slice(0, 120)}"`,
      ]
        .filter(Boolean)
        .join(' · ');
      await db.query(
        `UPDATE devices SET device_type = 'switch', type_source = 'inferred', type_confidence = 'high', type_evidence = $3 WHERE organization_id = $1 AND id = $2`,
        [c.organizationId, device.id, evidence],
      );
      await auditSystem(db, c.organizationId, {
        automation: KEY,
        action: 'device.type_inferred',
        target: { type: 'device', id: device.id },
        siteId: c.siteId,
        metadata: {
          device_type: 'switch',
          confidence: 'high',
          evidence,
          previous: { device_type: device.device_type, type_source: device.type_source, type_confidence: device.type_confidence },
          snmp_target_id: targetId,
          switch: label,
        },
      });
    }
    await db.query('RELEASE SAVEPOINT classify_switch');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT classify_switch');
    logger.error({ err, organization_id: c.organizationId, snmp_target_id: targetId }, 'switch classification from SNMP failed');
  }
}

const CANDIDATE_TYPES: DeviceType[] = ['router', 'switch', 'access_point', 'firewall'];
const macKey = (s: string) => s.toLowerCase().replace(/[^0-9a-f]/g, '');
const nameKey = (s: string) => s.trim().toLowerCase().split('.')[0]!;

interface DeviceRow {
  id: string;
  label: string;
  ip: string | null;
  mac: string | null;
  hostname: string | null;
  display_name: string | null;
  device_type: DeviceType;
  type_source: 'none' | 'inferred' | 'manual';
  type_confidence: Confidence | null;
  type_evidence: string | null;
  in_scope: boolean;
}

/** Devices that are probably switches (or switch-capable) and are not read over SNMP yet. Suggestions only. */
export function listSwitchCandidates(organizationId: string, siteId: string): Promise<{ site_id: string; items: SwitchCandidate[] }> {
  return withTenant(organizationId, async (db) => {
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
    const devices = (
      await db.query<DeviceRow>(
        `SELECT d.id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS label, host(d.current_ip) AS ip,
                d.primary_mac::text AS mac, d.hostname, d.display_name, d.device_type, d.type_source, d.type_confidence, d.type_evidence,
                EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = d.site_id AND s.enabled AND d.current_ip <<= s.cidr) AS in_scope
           FROM devices d
          WHERE d.site_id = $1
            AND NOT EXISTS (SELECT 1 FROM snmp_targets t WHERE t.site_id = d.site_id AND (t.device_id = d.id OR t.host = d.current_ip))
          ORDER BY d.current_ip NULLS LAST`,
        [siteId],
      )
    ).rows;
    const neighbors = (
      await db.query<{ switch_name: string; port_name: string; sys_name: string | null; chassis_id: string | null; protocol: string; address: string | null }>(
        `SELECT coalesce(t.name, t.sys_name, host(t.host)) AS switch_name, p.name AS port_name, n ->> 'sys_name' AS sys_name, n ->> 'chassis_id' AS chassis_id,
                coalesce(n ->> 'protocol', 'lldp') AS protocol, n ->> 'address' AS address
           FROM snmp_targets t JOIN switch_ports p ON p.target_id = t.id, jsonb_array_elements(p.neighbors) n
          WHERE t.site_id = $1 AND t.last_ok_at IS NOT NULL`,
        [siteId],
      )
    ).rows;

    const items: SwitchCandidate[] = [];
    for (const d of devices) {
      const reasons: SwitchCandidateReason[] = [];
      if (CANDIDATE_TYPES.includes(d.device_type)) {
        const how = d.type_source === 'manual' ? 'set by you' : `inferred, ${d.type_confidence ?? 'low'} confidence${d.type_evidence ? `: ${d.type_evidence}` : ''}`;
        reasons.push({ kind: 'classified', evidence: `Classified as ${d.device_type.replace('_', ' ')} (${how}); such devices often have a manageable switch` });
      }
      const names = [d.hostname, d.display_name].filter((x): x is string => Boolean(x)).map(nameKey);
      for (const n of neighbors) {
        const byMac = d.mac && n.chassis_id && macKey(n.chassis_id).length === 12 && macKey(n.chassis_id) === macKey(d.mac);
        const byName = n.sys_name && names.includes(nameKey(n.sys_name));
        const byAddress = !byMac && !byName && n.address !== null && n.address === d.ip;
        if (byMac || byName || byAddress) {
          const proto = n.protocol === 'cdp' ? 'CDP' : n.protocol === 'mikrotik' ? 'MikroTik neighbour discovery' : 'LLDP';
          reasons.push({
            kind: 'lldp_neighbor',
            evidence: `Announces itself over ${proto} on port ${n.port_name} of switch ${n.switch_name}${n.sys_name ? ` as "${n.sys_name}"` : ''} (matched by ${byMac ? 'MAC address' : byName ? 'name' : 'management address'})`,
          });
        }
      }
      if (!reasons.length) continue;
      items.push({
        device_id: d.id,
        label: d.label,
        ip: d.ip,
        mac: d.mac,
        device_type: d.device_type,
        type_source: d.type_source,
        type_confidence: d.type_confidence,
        in_scope: d.in_scope,
        inferred: true,
        reasons,
      });
    }
    return { site_id: siteId, items };
  });
}
