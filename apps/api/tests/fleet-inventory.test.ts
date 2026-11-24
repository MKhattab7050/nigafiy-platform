import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { evaluateCompliance } from '../src/modules/endpoints/capabilities.ts';
import { onlineEndpoint } from './fleet-helpers.ts';
import { CSRF, app, newAccount } from './helpers.ts';

// Fleet Pro (migration 043): hardware and licence inventory reported by the agent, and local
// administrators in compliance (names only; judged only against an allowed list, "not measured"
// when the agent could not read the group).

const HW = {
  collected_at: '2026-11-24T10:00:00Z',
  cpus: [{ name: 'Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz', manufacturer: 'GenuineIntel', cores: 6, threads: 12, max_mhz: 2592, socket: 'CPU 1' }],
  memory_modules: [{ slot: 'DIMM A', capacity_mb: 8192, speed_mhz: 2667, type: 'DDR4', manufacturer: '859B00000000', part_number: 'CB8GS2666.C8ET' }],
  system: { manufacturer: 'Dell Inc.', model: 'G3 3500', serial: '28491B3', sku: '09E1' },
  board: { manufacturer: 'Dell Inc.', product: '0HW9CF', version: 'A02' },
  bios: { vendor: 'Dell Inc.', version: '1.32.0', release_date: '2024-09-12' },
  licences: [{ kind: 'windows', product: 'Windows(R), Professional edition', status: 'licensed', detail: 'RETAIL channel', source: 'CIM SoftwareLicensingProduct' }],
  physical_disks: [{ name: 'NVMe KDI 512GB', media_type: 'SSD', bus: 'NVMe', size_gb: 512.1, health: 'healthy', reliability_note: 'reliability counters need the agent to run as an administrator', source: 'Get-PhysicalDisk' }],
  batteries: [{ name: 'DELL PN1VN11', full_charge_capacity_mwh: 34337, charge_pct: 100, status: 'on AC power', source: 'Win32_Battery' }],
  unmeasured: { battery_capacity: 'root/WMI battery classes: Generic failure' },
};

const ev = (subject: string, state = 'info', extra: Record<string, unknown> = {}) => ({
  check: 'local_admins',
  subject,
  state,
  value: state === 'info' ? 'member of Administrators' : '',
  source: 'Get-LocalGroupMember -SID S-1-5-32-544',
  measured_at: '2026-11-24T10:00:00Z',
  ...extra,
});

describe('fleet: hardware inventory', () => {
  it('stores what the agent measured, shows it on the endpoint, and refuses fields that could carry a key', async () => {
    const a = await newAccount('hw');
    const { epId, cred } = await onlineEndpoint(a, 'HW-PC');
    let d = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(d.body.hardware).toBeNull();

    const r = await request(app).post('/api/v1/agent/hardware').set('Authorization', `Bearer ${cred}`).send(HW);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    d = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(d.body.hardware.system.serial).toBe('28491B3');
    expect(d.body.hardware.licences[0].status).toBe('licensed');
    expect(d.body.hardware.unmeasured.battery_capacity).toMatch(/Generic failure/);
    expect(d.body.hardware_updated_at).toBeTruthy();

    // Strict: an unknown field (a product key) is refused and nothing is stored.
    const withKey = { ...HW, licences: [{ ...HW.licences[0], product_key: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' }] };
    expect((await request(app).post('/api/v1/agent/hardware').set('Authorization', `Bearer ${cred}`).send(withKey)).status).toBe(400);
    expect((await request(app).post('/api/v1/agent/hardware').set('Authorization', `Bearer ${cred}`).send({ ...HW, partial_product_key: 'ABCDE' })).status).toBe(400);
    const stored = await systemPool.query<{ hardware: string }>(`SELECT hardware::text FROM endpoints WHERE id = $1`, [epId]);
    expect(stored.rows[0]!.hardware).not.toMatch(/XXXXX|ABCDE/);
    // Without a credential: refused.
    expect((await request(app).post('/api/v1/agent/hardware').send(HW)).status).toBe(401);
    // Other organizations never see it.
    const b = await newAccount('hw-other');
    expect((await b.agent.get(`/api/v1/endpoints/${epId}`)).status).toBe(404);
  });
});

describe('fleet: local administrators (compliance)', () => {
  const base = { platform: 'windows' as const, diskUsedPct: 40 };

  it('shows members without judging them when no allowed list is set', () => {
    const r = evaluateCompliance({ ...base, security: { checks: [ev('PC\\Administrator'), ev('PC\\khattab')] } });
    const item = r.items.find((i) => i.key === 'local_admins')!;
    expect(item.judged).toBe(false);
    expect(item.reason_en).toMatch(/PC\\Administrator, PC\\khattab \(shown only/);
    // The other required items are unmeasured here, so the endpoint is unknown — never because of admins.
    expect(r.reasons.some((x) => /administrators/i.test(x))).toBe(false);
  });

  it('judges members against the allowed list: unexpected members need attention', () => {
    const security = { checks: [ev('PC\\Administrator'), ev('PC\\intruder'), ev('CONTOSO\\Domain Admins')] };
    const r = evaluateCompliance({ ...base, security, allowedLocalAdmins: ['Administrator', 'CONTOSO\\Domain Admins'] });
    const item = r.items.find((i) => i.key === 'local_admins')!;
    expect(item.judged).toBe(true);
    expect(item.verdict).toBe('attention');
    expect(item.reason_en).toBe('Unexpected local administrators: PC\\intruder');
    expect(item.evidence.find((e) => e.subject === 'PC\\Administrator')!.state).toBe('pass');
    expect(r.reasons).toContain('Unexpected local administrators: PC\\intruder');
    // A DOMAIN\name entry matches exactly only.
    const r2 = evaluateCompliance({ ...base, security: { checks: [ev('OTHER\\Domain Admins')] }, allowedLocalAdmins: ['CONTOSO\\Domain Admins'] });
    expect(r2.items.find((i) => i.key === 'local_admins')!.verdict).toBe('attention');
  });

  it('says "not measured" when the agent could not read the group, judged or not', () => {
    const unknown = { checks: [ev('Administrators', 'unknown', { reason: 'could not read the Administrators group: Access denied' })] };
    const shown = evaluateCompliance({ ...base, security: unknown }).items.find((i) => i.key === 'local_admins')!;
    expect(shown.verdict).toBe('unknown');
    expect(shown.reason_en).toMatch(/not measured: could not read/);
    const judged = evaluateCompliance({ ...base, security: unknown, allowedLocalAdmins: ['Administrator'] });
    expect(judged.items.find((i) => i.key === 'local_admins')!.verdict).toBe('unknown');
    // An allowed list with an older agent that sends nothing: required, so "not measured".
    const old = evaluateCompliance({ ...base, security: {}, allowedLocalAdmins: ['Administrator'] });
    expect(old.items.find((i) => i.key === 'local_admins')!.reason_en).toMatch(/not measured: not reported by the agent/);
  });

  it('the heartbeat and the policy route apply the allowed list; the policy change is audited', async () => {
    const a = await newAccount('admins');
    const { epId, cred } = await onlineEndpoint(a, 'ADM-PC');
    const hb = await request(app)
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${cred}`)
      .send({ agent_version: '0.3.0', hostname: 'ADM-PC', os: 'windows', arch: 'amd64', uptime_seconds: 60, cpu_pct: 5, ram_used_mb: 1000, ram_pct: 20, security: { checks: [ev('ADM-PC\\Administrator'), ev('ADM-PC\\guest2')] } });
    expect(hb.status, JSON.stringify(hb.body)).toBe(200);
    let d = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(d.body.compliance_items.find((i: { key: string }) => i.key === 'local_admins').judged).toBe(false);

    const p = await a.agent.patch(`/api/v1/endpoints/${epId}/policy`).set(CSRF).send({ allowed_local_admins: ['Administrator'] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    d = await a.agent.get(`/api/v1/endpoints/${epId}`);
    const item = d.body.compliance_items.find((i: { key: string }) => i.key === 'local_admins');
    expect(item.verdict).toBe('attention');
    expect(d.body.compliance_reasons).toContain('Unexpected local administrators: ADM-PC\\guest2');
    const audit = await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'endpoint.policy_updated'`, [a.organizationId]);
    expect(audit.rows[0]!.metadata.allowed_local_admins).toEqual(['Administrator']);
  });
});
