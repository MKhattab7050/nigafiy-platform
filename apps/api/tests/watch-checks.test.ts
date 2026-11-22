import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { classifySample } from '../src/modules/ingest/checks.ts';
import { diagnoseService, type CheckFacts } from '../src/modules/doctor/rules.ts';
import { buildInsights, type InsightFacts } from '../src/modules/insights/rules.ts';
import { rollupCheckResults } from '../src/modules/monitoring/rollup.ts';
import { CSRF, type TestAccount, addScope, heartbeat, newAccount, newCollector, setRole, telemetry } from './helpers.ts';

async function office() {
  const a = await newAccount('watch');
  await addScope(a, '192.168.7.0/24');
  const c = await newCollector(a);
  const create = (body: Record<string, unknown>) => a.agent.post('/api/v1/checks').set(CSRF).send({ site_id: a.siteId, ...body });
  return { a, c, create };
}

const auditRows = async (orgId: string, action: string) =>
  (await systemPool.query<{ metadata: Record<string, any> }>(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at`, [orgId, action])).rows;

const sample = (checkId: string, over: Record<string, unknown>, secondsAgo = 0) => ({
  type: 'check_result',
  check_id: checkId,
  ts: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  ok: true,
  latency_ms: 12,
  ...over,
});

async function check(a: TestAccount, id: string) {
  const list = (await a.agent.get(`/api/v1/checks?site_id=${a.siteId}`)).body.items as Record<string, any>[];
  return list.find((x) => x.id === id)!;
}

describe('watch check validation', () => {
  it('validates each kind and fills defaults', async () => {
    const { create } = await office();

    const http = await create({ name: 'NAS web', kind: 'https', target: '192.168.7.20', port: 8443, config: { path: '/health?x=1' } });
    expect(http.status).toBe(201);
    expect(http.body.config).toEqual({
      path: '/health?x=1',
      method: 'GET',
      expect_status: { min: 200, max: 299 },
      body_match: null,
      follow_redirects: true,
      max_redirects: 5,
      tls_verify: true,
      pin_sha256: null,
      allow_public: false,
    });
    // Plain HTTP stores no TLS settings.
    const plain = await create({ name: 'Printer page', kind: 'http', target: 'printer.lan', config: {} });
    expect(plain.status).toBe(201);
    expect(plain.body.config.tls_verify).toBeUndefined();
    expect(plain.body.port).toBeNull();

    const bad = async (body: Record<string, unknown>, code: string, status = 400) => {
      const res = await create({ name: 'x', ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(res.body.error.code).toBe(code);
    };
    await bad({ kind: 'http', target: '192.168.7.20', config: { path: 'no-slash' } }, 'invalid_config');
    await bad({ kind: 'http', target: '192.168.7.20', config: { body_match: { mode: 'regex', pattern: '(?=lookahead)' } } }, 'invalid_config');
    await bad({ kind: 'http', target: '192.168.7.20', config: { body_match: { mode: 'regex', pattern: '([a-z' } } }, 'invalid_config');
    await bad({ kind: 'http', target: '192.168.7.20', config: { method: 'HEAD', body_match: { mode: 'substring', pattern: 'ok' } } }, 'invalid_config');
    await bad({ kind: 'http', target: '192.168.7.20', config: { pin_sha256: 'ab'.repeat(32) } }, 'invalid_config');
    await bad({ kind: 'https', target: '192.168.7.20', config: { method: 'POST' } }, 'invalid_config');
    await bad({ kind: 'https', target: '192.168.7.20', config: { expect_status: { min: 300, max: 200 } } }, 'invalid_config');
    await bad({ kind: 'https', target: '192.168.7.20', config: { extra: true } }, 'invalid_config');
    await bad({ kind: 'tls_expiry', target: '192.168.7.20' }, 'invalid_target');
    await bad({ kind: 'tls_expiry', target: '192.168.7.20', port: 443, config: { warn_days: 7, critical_days: 14 } }, 'invalid_config');
    await bad({ kind: 'snmp_oid', config: { oid: '1.3.6.1.2.1.1.3.0', comparison: 'gt', critical: 5 } }, 'invalid_target');
    await bad({ kind: 'icmp', target: '192.168.7.20', config: { path: '/' } }, 'invalid_config');
    await bad({ kind: 'dns', target: 'example.com', port: 53 }, 'invalid_target');

    // The target rule (the collector applies it again on every resolved address).
    await bad({ kind: 'https', target: '192.168.8.20', config: {} }, 'out_of_scope', 422);
    await bad({ kind: 'https', target: '169.254.169.254', config: {} }, 'out_of_scope', 422);
    await bad({ kind: 'tls_expiry', target: '1.1.1.1', port: 443, config: {} }, 'public_not_allowed', 422);
    await bad({ kind: 'https', target: '224.0.0.1', config: { allow_public: true } }, 'out_of_scope', 422);
    expect((await create({ name: 'Public site cert', kind: 'tls_expiry', target: '1.1.1.1', port: 443, config: { allow_public: true } })).status).toBe(201);
    // A name is passed on: the collector resolves it and enforces the rule.
    expect((await create({ name: 'Intranet', kind: 'https', target: 'intranet.example.lan', config: { pin_sha256: 'AB:'.repeat(31) + 'AB' } })).body.config.pin_sha256).toBe('ab'.repeat(32));
  });

  it('snmp_oid reads a Port Detective device and is deleted with it', async () => {
    const { a, create } = await office();
    const sw = await a.agent.post('/api/v1/switches').set(CSRF).send({ site_id: a.siteId, host: '192.168.7.2', credentials: { version: '2c', community: 'ro-secret-77' } });
    expect(sw.status).toBe(201);
    const other = await newAccount('watch-other');
    await addScope(other, '192.168.7.0/24');
    const foreign = await other.agent.post('/api/v1/switches').set(CSRF).send({ site_id: other.siteId, host: '192.168.7.3', credentials: { version: '2c', community: 'x-secret-9' } });

    const missing = await create({ name: 'CPU', kind: 'snmp_oid', snmp_target_id: foreign.body.id, config: { oid: '1.3.6.1.2.1.25.3.3.1.2.1', comparison: 'gt', warn: 80, critical: 95 } });
    expect(missing.status).toBe(400);
    expect((await create({ name: 'CPU', kind: 'snmp_oid', snmp_target_id: sw.body.id, config: { oid: 'not-an-oid', comparison: 'gt', critical: 95 } })).status).toBe(400);
    expect((await create({ name: 'CPU', kind: 'snmp_oid', snmp_target_id: sw.body.id, config: { oid: '1.3.6.1.2.1.25.3.3.1.2.1', comparison: 'gt' } })).status).toBe(400);
    expect((await create({ name: 'CPU', kind: 'snmp_oid', snmp_target_id: sw.body.id, config: { oid: '1.3.6.1.2.1.25.3.3.1.2.1', comparison: 'gt', warn: 90, critical: 80 } })).status).toBe(400);

    const cpu = await create({ name: 'Core CPU', kind: 'snmp_oid', snmp_target_id: sw.body.id, config: { preset: 'cpu', oid: '1.3.6.1.2.1.25.3.3.1.2.1', comparison: 'gt', warn: 80, critical: 95, unit: '%' } });
    expect(cpu.status).toBe(201);
    expect(cpu.body).toMatchObject({ target: '192.168.7.2', snmp_target_id: sw.body.id, port: null });
    expect(cpu.body.config).toMatchObject({ oid: '.1.3.6.1.2.1.25.3.3.1.2.1', scale: 1, ratio_oid: null });

    const presets = await a.agent.get('/api/v1/checks/snmp-presets');
    expect(presets.body.items.map((p: { preset: string }) => p.preset)).toEqual(['cpu', 'memory', 'temperature', 'link_status']);

    expect((await a.agent.delete(`/api/v1/switches/${sw.body.id}`).set(CSRF)).status).toBe(204);
    expect(await check(a, cpu.body.id)).toBeUndefined();
  });

  it('only administrators create and change checks; changes are audited with their settings', async () => {
    const { a, create } = await office();
    await setRole(a.email, a.organizationId, 'technician');
    expect((await create({ name: 'x', kind: 'https', target: '192.168.7.20', config: {} })).status).toBe(403);
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await create({ name: 'x', kind: 'https', target: '192.168.7.20', config: {} })).status).toBe(403);
    await setRole(a.email, a.organizationId, 'admin');
    const created = await create({ name: 'Cert', kind: 'tls_expiry', target: '192.168.7.20', port: 443, config: { sni: 'nas.lan' } });
    expect(created.status).toBe(201);
    const audits = await auditRows(a.organizationId, 'check.created');
    expect(audits.at(-1)!.metadata).toMatchObject({ kind: 'tls_expiry', port: 443, config: { sni: 'nas.lan', warn_days: 30, critical_days: 7 } });

    // PATCH replaces the settings as a whole and re-validates them for the kind.
    const patched = await a.agent.patch(`/api/v1/checks/${created.body.id}`).set(CSRF).send({ config: { warn_days: 45, critical_days: 10 } });
    expect(patched.status).toBe(200);
    expect(patched.body.config).toEqual({ sni: null, warn_days: 45, critical_days: 10, allow_public: false });
    expect((await a.agent.patch(`/api/v1/checks/${created.body.id}`).set(CSRF).send({ config: { warn_days: 5, critical_days: 10 } })).status).toBe(400);
    expect((await auditRows(a.organizationId, 'check.updated')).at(-1)!.metadata.config).toMatchObject({ warn_days: 45 });
    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.patch(`/api/v1/checks/${created.body.id}`).set(CSRF).send({ name: 'y' })).status).toBe(403);
  });
});

describe('watch check results', () => {
  it('delivers settings to the collector and classifies values against thresholds', async () => {
    const { a, c, create } = await office();
    const cert = (await create({ name: 'NAS certificate', kind: 'tls_expiry', target: '192.168.7.20', port: 443, failure_threshold: 1, config: { warn_days: 30, critical_days: 7 } })).body;
    const web = (await create({ name: 'NAS web', kind: 'https', target: '192.168.7.20', failure_threshold: 1, config: { path: '/' } })).body;
    const sw = await a.agent.post('/api/v1/switches').set(CSRF).send({ site_id: a.siteId, host: '192.168.7.2', credentials: { version: '2c', community: 'ro-secret-88' } });
    const temp = (await create({ name: 'Core temperature', kind: 'snmp_oid', snmp_target_id: sw.body.id, failure_threshold: 1, config: { preset: 'temperature', oid: '1.3.6.1.4.1.14988.1.1.3.10.0', scale: 0.1, comparison: 'gt', warn: 60, critical: 75, unit: '°C' } })).body;

    const hb = await heartbeat(c);
    const delivered = hb.body.config.checks as Record<string, any>[];
    expect(delivered.find((x) => x.id === web.id)).toMatchObject({ kind: 'https', target: '192.168.7.20', port: null, config: { path: '/', tls_verify: true } });
    expect(delivered.find((x) => x.id === temp.id)).toMatchObject({ kind: 'snmp_oid', snmp_target_id: sw.body.id, config: { scale: 0.1 } });
    expect(hb.body.config.snmp.targets.map((t: { id: string }) => t.id)).toContain(sw.body.id);

    const details = { cert_subject: 'CN=nas.lan', cert_issuer: 'CN=Office CA', cert_not_after: new Date(Date.now() + 40 * 86_400_000).toISOString(), verified: false, cert_sha256: 'ab'.repeat(32) };
    let r = await telemetry(c, [sample(cert.id, { value: 40.2, details }, 30)]);
    expect(r.status).toBe(200);
    expect(r.body.rejected).toHaveLength(0);
    expect(await check(a, cert.id)).toMatchObject({ state: 'ok', last_value: 40.2, last_details: details });

    r = await telemetry(c, [sample(cert.id, { value: 20 }, 20)]);
    expect((await check(a, cert.id)).state).toBe('degraded');
    r = await telemetry(c, [sample(cert.id, { value: 3.5 }, 10)]);
    expect((await check(a, cert.id)).state).toBe('down');
    const events = (await a.agent.get(`/api/v1/events?site_id=${a.siteId}`)).body.items as Record<string, any>[];
    const down = events.find((e) => e.check_id === cert.id && e.type === 'check_down')!;
    expect(down.title).toBe('NAS certificate: certificate expires in 3 days');
    expect(down.details.reasons).toEqual(['The certificate expires in 3.50 days (critical at 7 days or fewer)']);
    expect(down.details.thresholds).toMatchObject({ warn_days: 30, critical_days: 7 });

    // HTTP: a wrong status is a failed sample with the status as its value.
    await telemetry(c, [sample(web.id, { ok: false, value: 503, error: 'unexpected HTTP status 503 (expected 200-299)', details: { status_code: 503, final_url: 'https://192.168.7.20/' } })]);
    expect(await check(a, web.id)).toMatchObject({ state: 'down', last_value: 503, last_error: 'unexpected HTTP status 503 (expected 200-299)' });

    // SNMP OID: warning and critical thresholds; warning then critical.
    await telemetry(c, [sample(temp.id, { value: 64.5, details: { oid: '.1.3.6.1.4.1.14988.1.1.3.10.0', raw_value: '645', value_type: 'Integer' } }, 5)]);
    expect((await check(a, temp.id)).state).toBe('degraded');
    const ev2 = (await a.agent.get(`/api/v1/events?site_id=${a.siteId}`)).body.items as Record<string, any>[];
    expect(ev2.find((e) => e.check_id === temp.id && e.type === 'check_degraded')!.title).toBe('Core temperature: warning threshold crossed');
    await telemetry(c, [sample(temp.id, { value: 80 })]);
    expect((await check(a, temp.id)).state).toBe('down');
    // The protocol is strict: a details field outside the schema (e.g. a response body) refuses the batch.
    expect((await telemetry(c, [sample(temp.id, { value: 1, details: { body: 'secret page' } })])).status).toBe(400);

    // The value is kept in the series and in the hourly roll-up.
    const series = await a.agent.get(`/api/v1/checks/${cert.id}/series?range=1h`);
    const withValue = (series.body.points as Record<string, any>[]).filter((p) => p.value !== null);
    expect(withValue.length).toBeGreaterThan(0);
    expect(Math.min(...withValue.map((p) => p.value_min))).toBe(3.5);
    await rollupCheckResults();
    const hourly = await systemPool.query<{ value_min: number; value_max: number }>(`SELECT min(value_min) AS value_min, max(value_max) AS value_max FROM check_results_hourly WHERE check_id = $1`, [cert.id]);
    expect(hourly.rows[0]).toEqual({ value_min: 3.5, value_max: 40.2 });
  });

  it('classifies samples deterministically', () => {
    const base = { latency_warn_ms: 100, loss_warn_pct: null };
    expect(classifySample({ ok: true, latency_ms: 5, value: 10 }, { ...base, kind: 'tls_expiry', config: { warn_days: 30, critical_days: 7 } }).state).toBe('degraded');
    expect(classifySample({ ok: true, latency_ms: 5, value: -1 }, { ...base, kind: 'tls_expiry', config: { warn_days: 30, critical_days: 7 } }).reasons[0]).toMatch(/expired 1 days ago/);
    expect(classifySample({ ok: true, latency_ms: 500, value: 90 }, { ...base, kind: 'tls_expiry', config: { warn_days: 30, critical_days: 7 } })).toEqual({
      state: 'degraded',
      reasons: ['Latency 500.0 ms is above the 100 ms threshold'],
    });
    const link = { ...base, kind: 'snmp_oid', config: { comparison: 'ne', warn: null, critical: 1 } };
    expect(classifySample({ ok: true, value: 1 }, link).state).toBe('ok');
    expect(classifySample({ ok: true, value: 2 }, link).state).toBe('down');
    const low = { ...base, kind: 'snmp_oid', config: { comparison: 'lt', warn: 20, critical: 10 } };
    expect(classifySample({ ok: true, value: 15 }, low).state).toBe('degraded');
    expect(classifySample({ ok: true, value: 25 }, low).state).toBe('ok');
    expect(classifySample({ ok: true }, low).state).toBe('down');
    expect(classifySample({ ok: false, error: 'no answer' }, low).reasons).toEqual(['The check failed: no answer']);
  });
});

describe('Network Doctor and insights understand watch checks', () => {
  const facts = (over: Partial<CheckFacts>): CheckFacts => ({
    id: 'c1',
    name: 'NAS web',
    kind: 'https',
    role: 'service',
    target: '192.168.7.20',
    port: null,
    state: 'down',
    last_result_at: new Date(),
    last_latency_ms: null,
    last_loss_pct: null,
    last_error: null,
    last_resolved_target: null,
    latency_warn_ms: null,
    recent_samples: 5,
    recent_ok: 0,
    recent_latency_ms: null,
    recent_loss_pct: null,
    baseline_latency_ms: null,
    baseline_samples: 0,
    config: {},
    last_value: null,
    last_details: null,
    ...over,
  });
  const diag = (over: Partial<CheckFacts>, host: 'online' | null = 'online') =>
    diagnoseService({ check: facts(over), host: host ? { name: 'nas', status: host, last_seen_at: new Date() } : null, network: 'healthy' });

  it('maps each failure to a deterministic rule', () => {
    expect(diag({ last_error: 'refused: 10.0.0.5 is outside the authorized ranges of this site' }).rule).toBe('watch-target-refused');
    expect(diag({ last_error: 'certificate not trusted: it is signed by an unknown authority (self-signed or private CA)' }).rule).toBe('watch-certificate-untrusted');
    expect(diag({ last_error: "the server's certificate does not match the pinned SHA-256 (it presents ab)" }).rule).toBe('watch-certificate-pin-mismatch');
    const http = diag({ last_error: 'unexpected HTTP status 502 (expected 200-299)', last_value: 502, last_details: { status_code: 502, final_url: 'https://192.168.7.20/' } });
    expect(http.rule).toBe('watch-http-status');
    expect(http.title).toBe('NAS web: HTTP 502');
    expect(http.probable_cause).toMatch(/5xx/);
    expect(http.evidence.some((e) => e.value === 'Status 502 from https://192.168.7.20/')).toBe(true);
    expect(diag({ last_error: 'the response body (first 256 KiB) does not contain the expected text' }).rule).toBe('watch-http-content');
    expect(diag({ last_error: 'connection refused (nothing is listening on that port)' }).rule).toBe('service-port-refused');

    const cert = diag({ kind: 'tls_expiry', port: 443, state: 'degraded', last_value: 12.4, config: { warn_days: 30, critical_days: 7 }, last_details: { cert_not_after: '2026-12-04T00:00:00Z', cert_issuer: 'CN=Office CA' } });
    expect(cert.rule).toBe('watch-certificate-expiring');
    expect(cert.title).toBe('NAS web: certificate expires in 12 days');
    expect(cert.evidence.find((e) => e.label === 'Certificate')!.value).toMatch(/^Expires 2026-12-04 \(in 12.4 days\) · issuer CN=Office CA$/);
    expect(diag({ kind: 'tls_expiry', port: 443, last_value: -3 }).rule).toBe('watch-certificate-expired');

    const snmp = { kind: 'snmp_oid' as const, target: '192.168.7.2' };
    const link = diag({ ...snmp, last_value: 2, config: { preset: 'link_status', oid: '.1.3.6.1.2.1.2.2.1.8.3', comparison: 'ne', critical: 1, unit: '' } });
    expect(link.rule).toBe('watch-snmp-threshold');
    expect(link.probable_cause).toMatch(/interface is not up/);
    expect(diag({ ...snmp, last_error: 'the device does not implement OID .1.3.6.1.2.1.25.3.3.1.2.1 (check the OID and its index)', config: { oid: '.1.3.6.1.2.1.25.3.3.1.2.1' } }).rule).toBe('watch-snmp-oid-missing');
    expect(diag({ ...snmp, last_error: 'no answer (wrong community / credentials, SNMP disabled, or the device does not allow this host)' }).rule).toBe('watch-snmp-unreadable');
    // Other failures fall through to the generic service rules.
    expect(diag({ last_error: 'no answer within 10s' }, null).rule).toBe('service-unresponsive');
  });

  it('reports expiring certificates and refused checks as insights', () => {
    const now = new Date('2026-11-22T12:00:00Z');
    const f: InsightFacts = {
      now,
      devices: [],
      collectors: [{ id: 'c', name: 'edge', last_heartbeat_at: now, gateway_ip: null }],
      scopes: 1,
      checks: [
        { id: '1', name: 'NAS cert', role: 'service', state: 'degraded', last_latency_ms: 5, last_loss_pct: null, kind: 'tls_expiry', last_error: null, last_value: 12.5, cert_not_after: null },
        { id: '2', name: 'Shop', role: 'service', state: 'ok', last_latency_ms: 5, last_loss_pct: null, kind: 'https', last_error: null, last_value: 200, cert_not_after: '2026-11-25T12:00:00Z' },
        { id: '3', name: 'Long cert', role: 'service', state: 'ok', last_latency_ms: 5, last_loss_pct: null, kind: 'tls_expiry', last_error: null, last_value: 200, cert_not_after: null },
        { id: '4', name: 'Metadata', role: 'service', state: 'down', last_latency_ms: null, last_loss_pct: null, kind: 'http', last_error: 'refused: 169.254.169.254 is outside the authorized ranges of this site', last_value: null, cert_not_after: null },
      ],
      openIncidents: [],
      ipConflicts: [],
    };
    const report = buildInsights(f);
    const certs = report.insights.find((i) => i.code === 'certificate_expiring')!;
    expect(certs).toMatchObject({ severity: 'critical', params: { count: 2, days: 3 } });
    expect(certs.evidence).toEqual(['Shop: expires in 3 day(s)', 'NAS cert: expires in 12 day(s)']);
    expect(report.insights.find((i) => i.code === 'watch_refused')!.evidence).toEqual(['Metadata: refused: 169.254.169.254 is outside the authorized ranges of this site']);
  });
});
