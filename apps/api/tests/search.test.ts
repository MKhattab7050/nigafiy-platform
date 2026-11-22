import { describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/common/crypto.ts';
import { systemPool, withTenant } from '../src/infrastructure/db.ts';
import {
  DEVICE_SEARCH_EXPR,
  ENDPOINT_SEARCH_EXPR,
  ROUTER_SEARCH_EXPR,
  SCOPE_SEARCH_EXPR,
  SUBNET_SEARCH_EXPR,
  SWITCH_SEARCH_EXPR,
} from '../src/modules/overview/search.ts';
import { addScope, heartbeat, newAccount, newCollector, sweep, telemetry } from './helpers.ts';

interface Hit {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
}

async function seed() {
  const a = await newAccount('search');
  const scopeId = await addScope(a, '192.168.77.0/24');
  const collector = await newCollector(a);
  await heartbeat(collector);
  const t = await telemetry(collector, [sweep(scopeId, [{ ip: '192.168.77.20', mac: 'aa:bb:cc:dd:ee:20', hostname: 'printer-floor2' }])]);
  expect(t.status).toBeLessThan(300);
  await systemPool.query(
    `INSERT INTO ipam_subnets (scope_id, organization_id, vlan_id, gateway, notes) VALUES ($1,$2,317,'192.168.77.1','Warehouse scanners segment')`,
    [scopeId, a.organizationId],
  );
  const sw = await systemPool.query<{ id: string }>(
    `INSERT INTO snmp_targets (organization_id, site_id, name, host, version, secret_enc, sys_name)
     VALUES ($1,$2,'Core switch',  '192.168.77.2','2c',$3,'core-sw-01') RETURNING id`,
    [a.organizationId, a.siteId, encryptSecret(JSON.stringify({ community: 'x' }))],
  );
  const rt = await systemPool.query<{ id: string }>(
    `INSERT INTO site_routers (organization_id, site_id, name, vendor, address, transport, secret_enc)
     VALUES ($1,$2,'Edge gateway','mikrotik','192.168.77.1','https',$3) RETURNING id`,
    [a.organizationId, a.siteId, encryptSecret(JSON.stringify({ username: 'u', password: 'p' }))],
  );
  return { a, scopeId, switchId: sw.rows[0]!.id, routerId: rt.rows[0]!.id };
}

describe('global search', () => {
  it('finds devices, switches, routers and IPAM subnets through the indexed expressions', async () => {
    const { a, scopeId, switchId, routerId } = await seed();
    const search = async (q: string): Promise<Hit[]> => {
      const res = await a.agent.get('/api/v1/search').query({ q });
      expect(res.status).toBe(200);
      return res.body.items;
    };

    expect((await search('printer-floor')).some((h) => h.kind === 'device')).toBe(true);
    expect((await search('aabbccddee20')).some((h) => h.kind === 'device')).toBe(true); // MAC without separators
    expect((await search('aa-bb-cc-dd-ee-20')).some((h) => h.kind === 'device')).toBe(true);
    expect((await search('core-sw')).find((h) => h.kind === 'switch')?.id).toBe(switchId);
    expect((await search('192.168.77.2')).find((h) => h.kind === 'switch')?.id).toBe(switchId);
    expect((await search('mikrotik')).find((h) => h.kind === 'router')?.id).toBe(routerId);
    // IPAM: notes, VLAN and gateway find the subnet, not only the scope's range.
    const byNotes = (await search('scanners')).find((h) => h.kind === 'subnet');
    expect(byNotes?.id).toBe(scopeId);
    expect(byNotes?.subtitle).toContain('VLAN 317');
    expect((await search('vlan 317')).find((h) => h.kind === 'subnet')?.id).toBe(scopeId);
    expect((await search('192.168.77.0')).find((h) => h.kind === 'subnet')?.id).toBe(scopeId);
    // LIKE wildcards in the query are literal.
    expect(await search('%')).toEqual([]);
    expect((await search('core_sw')).some((h) => h.kind === 'switch')).toBe(false);
  });

  it('never returns another organization’s rows', async () => {
    await seed();
    const other = await newAccount('search-other');
    const res = await other.agent.get('/api/v1/search').query({ q: 'scanners' });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    const res2 = await other.agent.get('/api/v1/search').query({ q: 'core-sw' });
    expect(res2.body.items).toEqual([]);
  });

  it('every search expression matches its trigram index (EXPLAIN)', async () => {
    const { a } = await seed();
    const ext = await systemPool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    if (!ext.rowCount) return; // pg_trgm unavailable: the migration skipped the indexes (documented)
    const cases: Array<[string, string, string, string]> = [
      ['devices d', DEVICE_SEARCH_EXPR, 'devices_search_all_trgm', 'printer'],
      ['endpoints e', ENDPOINT_SEARCH_EXPR, 'endpoints_search_all_trgm', 'laptop'],
      ['snmp_targets t', SWITCH_SEARCH_EXPR, 'snmp_targets_search_trgm', 'core'],
      ['site_routers r', ROUTER_SEARCH_EXPR, 'site_routers_search_trgm', 'edge'],
      ['network_scopes sc', SCOPE_SEARCH_EXPR, 'network_scopes_search_trgm', '192.168'],
      ['ipam_subnets i', SUBNET_SEARCH_EXPR, 'ipam_subnets_search_trgm', 'scanner'],
    ];
    const client = await systemPool.connect();
    try {
      await client.query('BEGIN');
      // Tiny test tables: forbid sequential scans so the plan shows whether the index CAN be used.
      await client.query('SET LOCAL enable_seqscan = off');
      for (const [table, expr, index, q] of cases) {
        const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT 1 FROM ${table} WHERE ${expr} ILIKE $1`, [`%${q}%`]);
        expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n'), table).toContain(index);
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // The same expressions as the application role, under Row Level Security: results are correct
    // (the planner's choice there is recorded in docs/features/global-search.md).
    const rows = await withTenant(a.organizationId, (db) =>
      db.query(`SELECT 1 FROM snmp_targets t WHERE ${SWITCH_SEARCH_EXPR} ILIKE $1`, ['%core-sw%']),
    );
    expect(rows.rowCount).toBe(1);
  });
});
