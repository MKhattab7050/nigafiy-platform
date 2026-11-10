import type { Confidence, PortRole } from '@lan-detective/shared-types';

export interface PortFacts {
  oper_up: boolean;
  mac_count: number;
  neighbors: unknown[];
}

/**
 * What a port is, from what was observed on it:
 *  - an LLDP neighbour was heard → a link to another switch (observed)
 *  - exactly one address → one device plugged in
 *  - a few addresses → something small behind it (desk switch, access point, phone + PC)
 *  - many addresses → an uplink or access point (inferred from the count; no LLDP confirmed it)
 */
export function portRole(p: PortFacts): PortRole {
  if (p.neighbors.length > 0) return 'uplink';
  if (p.mac_count === 0) return p.oper_up ? 'idle' : 'down';
  if (p.mac_count === 1) return 'edge';
  if (p.mac_count <= 4) return 'shared';
  return 'trunk';
}

export interface Sighting {
  target_id: string;
  switch_name: string;
  switch_host: string;
  if_index: number;
  port_name: string;
  port_alias: string | null;
  vlan: number;
  mac_count: number;
  neighbors: { sys_name?: string; port_id?: string }[];
  oper_up: boolean;
  speed_mbps: number;
  last_seen_at: string;
}

export interface PortLocation extends Sighting {
  role: PortRole;
  /** direct: the only device on the port. shared: a few devices share it. behind: reached through this port, exact port unknown. */
  kind: 'direct' | 'shared' | 'behind';
  confidence: Confidence;
  evidence: string[];
}

/**
 * A MAC address is learned on every switch its traffic crosses. The port closest to the device is
 * the one with the fewest addresses and no neighbouring switch; that is the one reported.
 */
export function locate(sightings: Sighting[]): PortLocation | null {
  if (!sightings.length) return null;
  const ranked = sightings
    .map((s) => ({ s, role: portRole(s) }))
    .sort((a, b) => Number(a.role === 'uplink') - Number(b.role === 'uplink') || a.s.mac_count - b.s.mac_count || a.s.switch_name.localeCompare(b.s.switch_name));
  const { s, role } = ranked[0]!;
  const others = s.mac_count - 1;
  const base = [`The switch ${s.switch_name} learned this device's address on port ${s.port_name}`];
  if (role === 'edge') {
    return { ...s, role, kind: 'direct', confidence: 'high', evidence: [...base, 'It is the only address on that port'] };
  }
  if (role === 'shared') {
    return {
      ...s,
      role,
      kind: 'shared',
      confidence: 'medium',
      evidence: [...base, `${others} other address(es) are on the same port: a small switch, an access point, or a phone and a computer share it`],
    };
  }
  const why =
    role === 'uplink'
      ? `That port leads to another switch (${s.neighbors.map((n) => n.sys_name || n.port_id).filter(Boolean).join(', ') || 'LLDP neighbour'}), which LAN Detective does not read`
      : `${others} other addresses are on that port, so it leads to an access point or an unmanaged switch`;
  return { ...s, role, kind: 'behind', confidence: 'low', evidence: [...base, why, 'The exact port beyond it is unknown'] };
}
