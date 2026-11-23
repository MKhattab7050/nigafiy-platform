import type { EndpointSecurityEvidence, EndpointSecurityPosture } from '@nigafiy/shared-types';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { evaluateCompliance } from '../src/modules/endpoints/capabilities.ts';
import { CSRF, app, newAccount, setRole } from './helpers.ts';

const AT = '2026-11-22T10:00:00Z';
const ev = (check: EndpointSecurityEvidence['check'], subject: string, state: EndpointSecurityEvidence['state'], extra: Partial<EndpointSecurityEvidence> = {}): EndpointSecurityEvidence => ({
  check,
  subject,
  state,
  value: `${subject} ${state}`,
  source: 'test fixture',
  measured_at: AT,
  ...extra,
});

/** A Windows workstation where every required item was measured and passed. */
function healthyWindows(): EndpointSecurityEvidence[] {
  return [
    ev('firewall', 'Domain profile', 'pass'),
    ev('firewall', 'Private profile', 'pass'),
    ev('firewall', 'Public profile', 'pass'),
    ev('antivirus', 'Microsoft Defender Antivirus', 'pass'),
    ev('disk_encryption', 'C:', 'pass'),
    ev('os_updates', 'Windows Update', 'pass', { count: 0 }),
  ];
}

const judge = (platform: 'windows' | 'linux' | 'macos', checks: EndpointSecurityEvidence[], diskUsedPct: number | null = 40, extra: EndpointSecurityPosture = {}) =>
  evaluateCompliance({ platform, diskUsedPct, security: { ...extra, checks, measured_at: AT } });

describe('evidence-only compliance verdicts (capabilities.ts)', () => {
  it('is compliant only when every required item was measured and passed', () => {
    const r = judge('windows', healthyWindows());
    expect(r.status).toBe('compliant');
    expect(r.reasons).toEqual([]);
    expect(r.items.map((i) => [i.key, i.verdict])).toEqual([
      ['firewall', 'compliant'],
      ['antivirus', 'compliant'],
      ['disk_encryption', 'compliant'],
      ['os_updates', 'compliant'],
      ['disk_space', 'compliant'],
    ]);
    const fw = r.items.find((i) => i.key === 'firewall')!;
    expect(fw.reason_en).toBe('Host firewall verified: Domain profile, Private profile, Public profile');
    expect(fw.reason_ar).toContain('تم التحقق');
    expect(fw.evidence).toHaveLength(3);
    expect(fw.evidence[0]).toMatchObject({ source: 'test fixture', measured_at: AT });
  });

  it('never calls an endpoint compliant without measurements', () => {
    expect(evaluateCompliance({ platform: 'windows', security: {} }).status).toBe('unknown');
    expect(evaluateCompliance({ platform: 'linux', security: null, diskUsedPct: null }).status).toBe('unknown');
    // Everything passed except BitLocker on D:, which could not be read: unknown, with the reason.
    const checks = [...healthyWindows(), ev('disk_encryption', 'D:', 'unknown', { reason: 'the agent is not running elevated' })];
    const r = judge('windows', checks);
    expect(r.status).toBe('unknown');
    expect(r.reasons).toEqual(['Disk encryption not measured: the agent is not running elevated']);
    expect(r.items.find((i) => i.key === 'disk_encryption')!.reason_ar).toContain('لم يتم قياس تشفير القرص');
    // A required item the agent did not report at all.
    const noUpdates = healthyWindows().filter((e) => e.check !== 'os_updates');
    expect(judge('windows', noUpdates).reasons).toEqual(['OS / security updates not measured: not reported by the agent']);
    // Only context ("info") evidence is not a measurement either.
    const infoOnly = healthyWindows().map((e) => (e.check === 'antivirus' ? { ...e, state: 'info' as const } : e));
    expect(judge('windows', infoOnly).status).toBe('unknown');
  });

  it('flags a firewall profile that is off as attention, naming the profile', () => {
    const checks = healthyWindows().map((e) => (e.subject === 'Public profile' ? { ...e, state: 'fail' as const } : e));
    const r = judge('windows', checks);
    expect(r.status).toBe('attention');
    expect(r.reasons).toEqual(['Host firewall is off: Public profile']);
  });

  it('treats no active antivirus as non-compliant and out-of-date signatures as attention', () => {
    const off = healthyWindows().map((e) => (e.check === 'antivirus' ? { ...e, state: 'fail' as const } : e));
    expect(judge('windows', off)).toMatchObject({ status: 'non_compliant', reasons: ['No active antivirus protection: Microsoft Defender Antivirus'] });
    const stale = healthyWindows().map((e) => (e.check === 'antivirus' ? { ...e, state: 'warn' as const } : e));
    expect(judge('windows', stale)).toMatchObject({ status: 'attention', reasons: ['Antivirus protection needs attention: Microsoft Defender Antivirus'] });
    // A disabled product next to an active one is context, not a failure.
    const twoAV = [...healthyWindows(), ev('antivirus', 'Windows Defender', 'info')];
    expect(judge('windows', twoAV).status).toBe('compliant');
  });

  it('evaluates disk encryption per volume and mount', () => {
    const win = [...healthyWindows(), ev('disk_encryption', 'D:', 'fail')];
    expect(judge('windows', win)).toMatchObject({ status: 'attention', reasons: ['Disk encryption is off: D:'] });
    const inProgress = healthyWindows().map((e) => (e.check === 'disk_encryption' ? { ...e, state: 'warn' as const } : e));
    expect(judge('windows', inProgress).reasons).toEqual(['Disk encryption needs attention: C:']);
    const linux = [
      ev('firewall', 'nftables', 'pass'),
      ev('firewall', 'ufw', 'info'),
      ev('disk_encryption', '/', 'pass'),
      ev('disk_encryption', '/home', 'fail'),
      ev('os_updates', 'APT', 'pass', { count: 0 }),
    ];
    expect(judge('linux', linux)).toMatchObject({ status: 'attention', reasons: ['Disk encryption is off: /home'] });
  });

  it('counts pending updates across evidence and keeps the established reason text', () => {
    const checks = healthyWindows().map((e) => (e.check === 'os_updates' ? { ...e, state: 'fail' as const, count: 4 } : e));
    expect(judge('windows', checks)).toMatchObject({ status: 'attention', reasons: ['4 OS/security update(s) pending'] });
  });

  it('judges macOS SIP (non-compliant) and Gatekeeper (attention) and requires both', () => {
    const mac = [
      ev('firewall', 'Application Firewall', 'pass'),
      ev('firewall', 'pf packet filter', 'info'),
      ev('disk_encryption', 'FileVault', 'pass'),
      ev('sip', 'System Integrity Protection', 'pass'),
      ev('gatekeeper', 'Gatekeeper', 'pass'),
      ev('os_updates', 'Software Update', 'pass', { count: 0 }),
    ];
    expect(judge('macos', mac).status).toBe('compliant');
    const sipOff = mac.map((e) => (e.check === 'sip' ? { ...e, state: 'fail' as const } : e));
    expect(judge('macos', sipOff)).toMatchObject({ status: 'non_compliant', reasons: ['System Integrity Protection is disabled'] });
    const gkOff = mac.map((e) => (e.check === 'gatekeeper' ? { ...e, state: 'fail' as const } : e));
    expect(judge('macos', gkOff)).toMatchObject({ status: 'attention', reasons: ['Gatekeeper is disabled'] });
    expect(judge('macos', mac.filter((e) => e.check !== 'sip')).status).toBe('unknown');
  });

  it('orders reasons by severity and flags a nearly full disk', () => {
    const checks = healthyWindows()
      .map((e) => (e.check === 'antivirus' ? { ...e, state: 'fail' as const } : e))
      .concat(ev('disk_encryption', 'E:', 'unknown', { reason: 'locked volume' }));
    const r = judge('windows', checks, 95.04);
    expect(r.status).toBe('non_compliant');
    expect(r.reasons).toEqual([
      'No active antivirus protection: Microsoft Defender Antivirus',
      'Disk usage is critically high (95.0%)',
      'Disk encryption not measured: locked volume',
    ]);
  });

  it('still judges older agents from their yes/no fields, marked as such', () => {
    const r = evaluateCompliance({ platform: 'windows', diskUsedPct: 20, security: { firewall_enabled: false, antivirus_enabled: true, disk_encrypted: true, pending_updates: 0 } });
    expect(r.status).toBe('attention');
    expect(r.reasons).toEqual(['Host firewall is reported off']);
    expect(r.items.find((i) => i.key === 'firewall')!.evidence[0]).toMatchObject({ source: 'agent posture field (no per-item evidence)', value: 'firewall_enabled=false' });
    const linuxAv = evaluateCompliance({ platform: 'linux', security: { antivirus_enabled: false } });
    expect(linuxAv.items.some((i) => i.key === 'antivirus')).toBe(false);
  });
});

describe('fleet compliance and file-manager overwrite through the API', () => {
  async function enrolledWindows(prefix: string) {
    const a = await newAccount(prefix);
    const created = await a.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: a.siteId, name: 'Finance PC', platform: 'windows' });
    const enrolled = await request(app).post('/api/v1/agent/enroll').send({
      enrollment_token: created.body.enrollment_token,
      hostname: 'FIN-01',
      agent_version: '0.4.0',
      os: 'windows',
      arch: 'amd64',
    });
    expect(enrolled.status).toBe(201);
    const cred: string = enrolled.body.credential;
    const hb = (security: Record<string, unknown>) =>
      request(app)
        .post('/api/v1/agent/heartbeat')
        .set('Authorization', `Bearer ${cred}`)
        .send({ agent_version: '0.4.0', hostname: 'FIN-01', os: 'windows', arch: 'amd64', cpu_pct: 5, ram_used_mb: 2048, ram_pct: 30, disk_used_pct: 41.5, security });
    return { a, epId: created.body.endpoint.id as string, hb };
  }

  it('stores the evidence, returns per-item verdicts and refuses malformed evidence', async () => {
    const { a, epId, hb } = await enrolledWindows('fc-evidence');
    const checks = [...healthyWindows().slice(0, 5), ev('disk_encryption', 'D:', 'unknown', { reason: 'reading BitLocker status needs administrator rights' }), ev('os_updates', 'Windows Update', 'fail', { count: 2 })];
    const res = await hb({ firewall_enabled: true, antivirus_enabled: true, pending_updates: 2, checks, measured_at: AT });
    expect(res.status).toBe(200);

    const detail = await a.agent.get(`/api/v1/endpoints/${epId}`);
    expect(detail.body.compliance_status).toBe('attention');
    expect(detail.body.compliance_reasons).toEqual(['2 OS/security update(s) pending', 'Disk encryption not measured: reading BitLocker status needs administrator rights']);
    const items = detail.body.compliance_items as { key: string; verdict: string; evidence: EndpointSecurityEvidence[] }[];
    expect(items.map((i) => i.key)).toEqual(['firewall', 'antivirus', 'disk_encryption', 'os_updates', 'disk_space']);
    expect(items.find((i) => i.key === 'disk_encryption')).toMatchObject({ verdict: 'unknown' });
    expect(detail.body.security.checks).toHaveLength(7);

    // Evidence is strictly validated: unknown check names, states or control characters are refused.
    expect((await hb({ checks: [{ ...ev('firewall', 'x', 'pass'), check: 'rootkit' }] })).status).toBe(400);
    expect((await hb({ checks: [{ ...ev('firewall', 'x', 'pass'), state: 'ok' }] })).status).toBe(400);
    expect((await hb({ checks: [{ ...ev('firewall', 'x', 'pass'), value: 'a\u0007b' }] })).status).toBe(400);
    expect((await hb({ checks: [{ ...ev('firewall', 'x', 'pass'), measured_at: 'yesterday' }] })).status).toBe(400);
  });

  it('carries an operator-confirmed overwrite to the agent and records it in the audit log', async () => {
    const { a, epId, hb } = await enrolledWindows('fc-overwrite');
    expect((await hb({})).status).toBe(200);
    const send = (body: Record<string, unknown>) => a.agent.post(`/api/v1/endpoints/${epId}/commands`).set(CSRF).send({ kind: 'fs_op', ...body });
    const path = 'C:\\Users\\Public\\report.xlsx';
    const data = Buffer.from('new report').toString('base64');

    const confirmed = await send({ op: 'upload', path, offset: 0, data_base64: data, overwrite: true });
    expect(confirmed.status).toBe(202);
    expect(confirmed.body.payload.overwrite).toBe(true);

    // overwrite belongs to an upload's first chunk only.
    expect((await send({ op: 'upload', path, offset: 262_144, data_base64: data, overwrite: true })).status).toBe(400);
    expect((await send({ op: 'copy', paths: [path], target_path: 'C:\\Temp', overwrite: true })).status).toBe(400);
    expect((await send({ op: 'upload', path, overwrite: 'yes', data_base64: data })).status).toBe(400);

    const audited = await systemPool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs WHERE target_id = $1 AND action = 'endpoint.fs_op' ORDER BY created_at`,
      [epId],
    );
    const row = audited.rows.find((r) => r.metadata.op === 'upload');
    expect(row?.metadata).toMatchObject({ op: 'upload', path, overwrite: true, data_bytes: 10 });
    expect(JSON.stringify(row?.metadata)).not.toContain(data);

    // A technician still cannot upload at all, confirmed or not.
    await setRole(a.email, a.organizationId, 'technician');
    expect((await send({ op: 'upload', path, data_base64: data, overwrite: true })).status).toBe(403);
  });
});
