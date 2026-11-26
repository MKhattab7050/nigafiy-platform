import type { Db } from '../../infrastructure/db.ts';
import { ownerFromName } from './owner-name.ts';

/**
 * A device with the Nigafiy app or agent on it says first-hand what it is: its own name (the one its
 * owner gave it in Settings, "محمد's A36"), its maker and its operating system. The scan only sees the
 * router's spelling ("mhmd-s-A36") and, behind a private MAC address, no maker at all. So the network
 * device linked to the endpoint takes those facts, without anyone typing them:
 *
 * - its name, marked "reported by the Nigafiy app" (a scan never replaces it; a person's own display
 *   name always wins, since that is a separate column this never touches);
 * - its maker, only when the network card did not give one;
 * - its type, unless a person set it;
 * - its owner from that name ("محمد's A36" -> محمد), only while nobody set or cleared the owner.
 */

const PLATFORM_TYPE: Record<string, { type: string; what: string }> = {
  android: { type: 'mobile', what: 'an Android phone' },
  windows: { type: 'windows_computer', what: 'a Windows computer' },
  linux: { type: 'linux_computer', what: 'a Linux computer' },
  macos: { type: 'apple_computer', what: 'a Mac' },
};

/** "samsung" -> "Samsung"; "HUAWEI" -> "Huawei"; null for empty or generic answers. */
export function makerName(raw: string | null | undefined): string | null {
  const m = raw?.trim();
  if (!m || /^(unknown|generic|android|default)$/i.test(m) || m.length > 60) return null;
  return m === m.toLowerCase() || m === m.toUpperCase() ? m.charAt(0).toUpperCase() + m.slice(1).toLowerCase() : m;
}

type Row = {
  hostname: string | null;
  name_source: string | null;
  vendor: string | null;
  device_type: string | null;
  type_source: string;
  type_confidence: string | null;
  type_evidence: string | null;
  owner: string | null;
  owner_source: string | null;
};

export async function applyAgentIdentity(
  db: Db,
  deviceId: string,
  agent: { hostname: string | null | undefined; manufacturer?: string | null; platform: string },
): Promise<boolean> {
  const r = await db.query<Row>(
    `SELECT hostname, name_source, vendor, device_type, type_source, type_confidence, type_evidence, owner, owner_source
       FROM devices WHERE id = $1`,
    [deviceId],
  );
  const d = r.rows[0];
  if (!d) return false;
  const sets: string[] = [];
  const values: unknown[] = [deviceId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  const name = agent.hostname?.trim() || null;
  if (name && name.toLowerCase() !== 'android' && (d.hostname !== name || d.name_source !== 'agent')) {
    set('hostname', name);
    set('name_source', 'agent');
  }

  const maker = makerName(agent.manufacturer);
  if (maker && !d.vendor) set('vendor', maker);

  const kind = PLATFORM_TYPE[agent.platform];
  if (kind && d.type_source !== 'manual') {
    const evidence = `The Nigafiy app on it reports that it is ${kind.what}`;
    if (d.device_type !== kind.type || d.type_confidence !== 'high' || d.type_evidence !== evidence) {
      set('device_type', kind.type);
      set('type_source', 'inferred');
      set('type_confidence', 'high');
      set('type_evidence', evidence);
    }
  }

  if (!d.owner && !d.owner_source && name) {
    const owner = ownerFromName(name);
    if (owner) {
      set('owner', owner);
      set('owner_source', 'name');
    }
  }

  if (!sets.length) return false;
  await db.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $1`, values);
  return true;
}
