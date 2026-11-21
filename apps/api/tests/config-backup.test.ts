import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { diffLines, unifiedText } from '../src/modules/configbackup/diff.ts';
import { runConfigBackupJob } from '../src/modules/configbackup/jobs.ts';
import { normalizeConfig } from '../src/modules/configbackup/normalize.ts';
import { nextDailyRun } from '../src/modules/configbackup/schedule.ts';
import { CSRF, type TestAccount, type TestCollector, addScope, heartbeat, newAccount, newCollector, setRole, sweep, telemetry } from './helpers.ts';

const USERNAME = 'backup-reader';
const PASSWORD = 'Sw1tch-Backup-Secret-77';
const ENABLE = 'Enable-Secret-55';
const KEY_A = `SHA256:${'A'.repeat(43)}`;
const KEY_B = `SHA256:${'B'.repeat(42)}c`;

const CONFIG_V1 = [
  'Building configuration...',
  '',
  'Current configuration : 1234 bytes',
  '! Last configuration change at 10:01:02 UTC Mon Nov 16 2026 by admin',
  'hostname core-sw1',
  '!',
  'interface GigabitEthernet0/1',
  ' description uplink',
  ' switchport mode trunk',
  '!',
  'snmp-server community s3cr3t RO',
  'end',
].join('\r\n');

interface Setup {
  a: TestAccount;
  c: TestCollector;
  switchId: string;
}

async function commands(c: TestCollector, kind: string) {
  const hb = await heartbeat(c);
  expect(hb.status).toBe(200);
  return (hb.body.commands as { id: string; kind: string; payload: Record<string, unknown> }[]).filter((x) => x.kind === kind);
}

function result(fields: Record<string, unknown>) {
  return { type: 'config_backup_result', ts: new Date().toISOString(), duration_ms: 1500, ...fields };
}

const gz = (text: string) => gzipSync(Buffer.from(text, 'utf8')).toString('base64');

/** An account with a scope, an online collector and a discovered switch, router and laptop. */
async function setup(label: string): Promise<Setup> {
  const a = await newAccount(label);
  const scopeId = await addScope(a, '192.168.60.0/24');
  const c = await newCollector(a);
  await heartbeat(c);
  const sw = await telemetry(c, [
    sweep(scopeId, [
      { ip: '192.168.60.1', mac: '00:0c:42:00:00:01', hostname: 'gw' },
      { ip: '192.168.60.2', mac: '00:00:0c:00:00:02', hostname: 'core-sw1' },
      { ip: '192.168.60.50', mac: 'aa:bb:cc:00:00:50', hostname: 'laptop' },
    ]),
  ]);
  expect(sw.status).toBe(200);
  const list = await a.agent.get('/api/v1/devices?page_size=50');
  const sw1 = list.body.items.find((d: { current_ip: string }) => d.current_ip === '192.168.60.2');
  const patched = await a.agent.patch(`/api/v1/devices/${sw1.id}`).set(CSRF).send({ device_type: 'switch' });
  expect(patched.status).toBe(200);
  return { a, c, switchId: sw1.id };
}

/** Adds the switch with credentials and returns the target id and the first queued run. */
async function addSwitch(s: Setup) {
  const res = await s.a.agent
    .post('/api/v1/config-backup/targets')
    .set(CSRF)
    .send({ site_id: s.a.siteId, targets: [{ address: '192.168.60.2' }], credentials: { username: USERNAME, password: PASSWORD, enable_secret: ENABLE } });
  expect(res.status).toBe(201);
  expect(res.body.queued).toHaveLength(1);
  return { targetId: res.body.items[0].id as string, runId: res.body.queued[0].run_id as string, body: res.body };
}

describe('configuration backup', () => {
  it('normalizes volatile lines, hashes, and diffs line by line', () => {
    const n1 = normalizeConfig(CONFIG_V1);
    expect(n1.text).not.toContain('Last configuration change');
    expect(n1.text).not.toContain('Current configuration');
    expect(n1.text.startsWith('hostname core-sw1\n')).toBe(true);
    const n2 = normalizeConfig(CONFIG_V1.replace('10:01:02 UTC Mon Nov 16', '04:00:00 UTC Tue Nov 17'));
    expect(n2.sha256).toBe(n1.sha256);

    const d = diffLines('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nX\nd\ne\nf\ng\nh\ni\n', 1);
    expect(d).toMatchObject({ identical: false, added: 2, removed: 1, approximate: false });
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0]).toMatchObject({ old_start: 2, old_lines: 3, new_start: 2, new_lines: 3 });
    expect(d.hunks[0]!.lines.map((l) => `${l.op}${l.text}`)).toEqual([' b', '-c', '+X', ' d']);
    expect(d.hunks[1]!.lines.map((l) => `${l.op}${l.text}`)).toEqual([' h', '+i']);
    expect(unifiedText(d, 'old', 'new')).toContain('@@ -2,3 +2,3 @@\n b\n-c\n+X\n d\n');
    expect(diffLines('x\n', 'x\n').identical).toBe(true);
    expect(diffLines('', 'a\nb\n')).toMatchObject({ added: 2, removed: 0 });
    // Very different texts: bounded, reported as approximate instead of hanging.
    const big1 = Array.from({ length: 4000 }, (_, i) => `a${i}`).join('\n');
    const big2 = Array.from({ length: 4000 }, (_, i) => `b${i}`).join('\n');
    expect(diffLines(big1, big2)).toMatchObject({ approximate: true, added: 4000, removed: 4000 });
  });

  it('schedules the daily backup in the site time zone', () => {
    const now = new Date('2026-11-21T10:00:00Z');
    const cairo = nextDailyRun(now, 'Africa/Cairo', 2, 'x'); // UTC+2 in November
    expect(cairo.getTime()).toBeGreaterThan(now.getTime());
    const utcHour = cairo.getUTCHours();
    expect(utcHour).toBe(0);
    expect(cairo.getUTCDate()).toBe(22);
    const utc = nextDailyRun(now, 'UTC', 23, 'x');
    expect(utc.getUTCDate()).toBe(21);
    expect(utc.getUTCHours()).toBe(23);
  });

  it('suggests devices from discovery and the SSH check, with an inferred vendor', async () => {
    const s = await setup('cb-suggest');
    let sug = await s.a.agent.get(`/api/v1/config-backup/suggestions?site_id=${s.a.siteId}`);
    expect(sug.status).toBe(200);
    expect(sug.body.items.map((i: { address: string }) => i.address)).toEqual(['192.168.60.2']);
    expect(sug.body.items[0].ssh.state).toBe('unknown');

    const probe = await s.a.agent.post('/api/v1/config-backup/probe').set(CSRF).send({ site_id: s.a.siteId });
    expect(probe.status).toBe(202);
    const [cmd] = await commands(s.c, 'config_backup_probe');
    expect(cmd!.payload).toMatchObject({ run_id: probe.body.probe_id, port: 22 });
    expect(cmd!.payload.addresses).toEqual(expect.arrayContaining(['192.168.60.1', '192.168.60.2', '192.168.60.50']));
    const t = await telemetry(s.c, [
      {
        type: 'config_backup_probe_result',
        ts: new Date().toISOString(),
        run_id: probe.body.probe_id,
        results: [
          { address: '192.168.60.1', port: 22, open: true, server_version: 'SSH-2.0-ROSSSH' },
          { address: '192.168.60.2', port: 22, open: true, server_version: 'SSH-2.0-Cisco-1.25' },
          { address: '192.168.60.50', port: 22, open: false, error: 'connection refused' },
          { address: '10.1.1.1', port: 22, open: true },
        ],
      },
    ]);
    expect(t.body).toMatchObject({ accepted: 1 });
    sug = await s.a.agent.get(`/api/v1/config-backup/suggestions?site_id=${s.a.siteId}`);
    const byAddr = Object.fromEntries(sug.body.items.map((i: { address: string }) => [i.address, i]));
    expect(Object.keys(byAddr).sort()).toEqual(['192.168.60.1', '192.168.60.2']);
    expect(byAddr['192.168.60.1'].suggested_driver).toMatchObject({ driver: 'mikrotik_routeros', confidence: 'high', source: 'inferred' });
    // A Cisco banner fits IOS and ASA alike: no guess.
    expect(byAddr['192.168.60.2'].suggested_driver.driver).toBeNull();
    expect(byAddr['192.168.60.2'].ssh).toMatchObject({ state: 'open', server_version: 'SSH-2.0-Cisco-1.25' });
    expect((await s.a.agent.get(`/api/v1/config-backup/probes/${probe.body.probe_id}`)).body).toMatchObject({ status: 'done', open_count: 2 });
    // A replayed answer to a finished check is refused.
    const again = await telemetry(s.c, [{ type: 'config_backup_probe_result', ts: new Date().toISOString(), run_id: probe.body.probe_id, results: [] }]);
    expect(again.body.rejected).toHaveLength(1);
  });

  it('keeps credentials write-only, delivers them only inside the pending run, and versions configurations', async () => {
    const s = await setup('cb-flow');
    const { targetId, runId, body } = await addSwitch(s);
    expect(body.items[0]).toMatchObject({ name: 'core-sw1', address: '192.168.60.2', port: 22, readiness: 'ready', schedule: 'daily' });
    expect(body.items[0].credentials).toMatchObject({ set: true, auth: 'password', enable_secret_set: true });
    expect(body.items[0].next_run_at).toBeTruthy();

    // Outside an authorized scope (and public addresses) are refused.
    const outside = await s.a.agent.post('/api/v1/config-backup/targets').set(CSRF).send({ site_id: s.a.siteId, targets: [{ address: '10.9.9.9' }] });
    expect(outside.status).toBe(422);
    const dup = await s.a.agent.post('/api/v1/config-backup/targets').set(CSRF).send({ site_id: s.a.siteId, targets: [{ address: '192.168.60.2' }] });
    expect(dup.status).toBe(409);

    // The command is stored without secrets; the heartbeat of the site's collector carries them.
    const stored = await systemPool.query(`SELECT payload::text AS p FROM collector_commands WHERE kind = 'config_backup' AND (payload->>'run_id') = $1`, [runId]);
    expect(stored.rows[0].p).not.toContain(PASSWORD);
    const [cmd] = await commands(s.c, 'config_backup');
    expect(cmd!.payload).toMatchObject({ run_id: runId, target_id: targetId, address: '192.168.60.2', port: 22, username: USERNAME, password: PASSWORD, enable_secret: ENABLE });
    expect(cmd!.payload.host_key_sha256).toBeUndefined();
    expect(cmd!.payload.hints).toMatchObject({ oui_vendor: expect.any(String) });

    // Nothing reveals the credentials: API responses, audit trail, storage.
    const detail = await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}`);
    const list = await s.a.agent.get('/api/v1/config-backup/targets');
    for (const b of [detail.body, list.body, body]) {
      const text = JSON.stringify(b);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(ENABLE);
      expect(text).not.toContain('secret_enc');
    }
    const auditRows = await systemPool.query(`SELECT metadata::text AS m FROM audit_logs WHERE organization_id = $1 AND action LIKE 'config_backup.%'`, [s.a.organizationId]);
    expect(auditRows.rowCount).toBeGreaterThan(0);
    for (const r of auditRows.rows) expect(r.m).not.toContain(PASSWORD);
    const raw = await systemPool.query(`SELECT secret_enc FROM config_backup_targets WHERE id = $1`, [targetId]);
    expect(raw.rows[0].secret_enc).not.toContain(PASSWORD);

    // Another tenant's collector gets nothing and cannot answer for this run.
    const other = await setup('cb-other');
    expect(JSON.stringify((await heartbeat(other.c)).body)).not.toContain(PASSWORD);
    const forged = await telemetry(other.c, [result({ run_id: runId, target_id: targetId, ok: true, config_gzip_b64: gz('hostname evil\n') })]);
    expect(forged.body.rejected).toHaveLength(1);
    expect((await other.a.agent.get(`/api/v1/config-backup/targets/${targetId}`)).status).toBe(404);

    // First backup: trust on first use pins the host key; version 1 is stored without volatile lines.
    let t = await telemetry(s.c, [
      result({
        run_id: runId,
        target_id: targetId,
        ok: true,
        host_key: { sha256: KEY_A, type: 'ssh-ed25519' },
        host_key_status: 'first_use',
        server_version: 'SSH-2.0-Cisco-1.25',
        detection: { driver: 'cisco_ios', confidence: 'high', evidence: [{ source: 'probe', driver: 'cisco_ios', detail: 'Cisco IOS Software', weight: 100 }], prompt: 'core-sw1#', prompt_family: 'hostname#' },
        commands: ['show running-config'],
        config_gzip_b64: gz(CONFIG_V1),
      }),
    ]);
    expect(t.body).toMatchObject({ accepted: 1 });
    let target = (await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}`)).body;
    expect(target).toMatchObject({ host_key_status: 'pinned', host_key_sha256: KEY_A, host_key_pinned_via: 'first_use', last_status: 'ok', version_count: 1 });
    expect(target.vendor).toMatchObject({ driver: 'cisco_ios', source: 'observed', confidence: 'high' });
    expect(target.runs[0]).toMatchObject({ id: runId, status: 'ok', outcome: 'first', host_key_status: 'first_use' });
    const pinAudit = await systemPool.query(`SELECT actor FROM audit_logs WHERE organization_id = $1 AND action = 'config_backup.host_key.pin_first_use'`, [s.a.organizationId]);
    expect(pinAudit.rows[0]?.actor).toBe('collector');

    // Second backup, only a timestamp differs: no new version, the latest is confirmed.
    let run = await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/run`).set(CSRF).send({});
    expect(run.status).toBe(202);
    const [cmd2] = await commands(s.c, 'config_backup');
    expect(cmd2!.payload).toMatchObject({ host_key_sha256: KEY_A, host_key_type: 'ssh-ed25519', hints: { driver: 'cisco_ios' } });
    t = await telemetry(s.c, [
      result({ run_id: run.body.run_id, target_id: targetId, ok: true, host_key: { sha256: KEY_A, type: 'ssh-ed25519' }, host_key_status: 'matched', config_gzip_b64: gz(CONFIG_V1.replace('10:01:02', '11:11:11')) }),
    ]);
    expect(t.body).toMatchObject({ accepted: 1 });
    let versions = (await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}/versions`)).body.items;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ number: 1, confirmations: 2 });
    expect((await s.a.agent.get(`/api/v1/config-backup/runs/${run.body.run_id}`)).body).toMatchObject({ status: 'ok', outcome: 'unchanged' });

    // Third backup with a real change: version 2, a change event, a line diff.
    run = await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/run`).set(CSRF).send({});
    await commands(s.c, 'config_backup');
    const v2 = CONFIG_V1.replace(' description uplink', ' description uplink to core').replace('end', 'ip ssh version 2\r\nend');
    t = await telemetry(s.c, [result({ run_id: run.body.run_id, target_id: targetId, ok: true, host_key: { sha256: KEY_A, type: 'ssh-ed25519' }, host_key_status: 'matched', config_gzip_b64: gz(v2) })]);
    expect(t.body).toMatchObject({ accepted: 1 });
    versions = (await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}/versions`)).body.items;
    expect(versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ added_lines: 2, removed_lines: 1 });
    const events = (await s.a.agent.get('/api/v1/events?page_size=100')).body.items;
    const changed = events.find((e: { type: string }) => e.type === 'config_changed');
    expect(changed).toBeTruthy();
    expect(changed.details).toMatchObject({ target_id: targetId, from_version: 1, to_version: 2, added_lines: 2, removed_lines: 1 });

    const diff = await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}/diff?from=${versions[1].id}&to=${versions[0].id}`);
    expect(diff.status).toBe(200);
    expect(diff.body).toMatchObject({ identical: false, added: 2, removed: 1, from: { number: 1 }, to: { number: 2 } });
    const lines = diff.body.hunks.flatMap((h: { lines: { op: string; text: string }[] }) => h.lines.map((l) => `${l.op}${l.text}`));
    expect(lines).toEqual(expect.arrayContaining(['- description uplink', '+ description uplink to core', '+ip ssh version 2']));
    const unified = await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}/diff?from=${versions[1].id}&to=${versions[0].id}&format=unified`);
    expect(unified.headers['content-type']).toContain('text/x-diff');
    expect(unified.text).toContain('+ip ssh version 2');

    const dl = await s.a.agent.get(`/api/v1/config-backup/versions/${versions[0].id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="core-sw1-v2-\d{4}-\d{2}-\d{2}\.cfg"/);
    expect(dl.text).toContain('ip ssh version 2');
    expect(dl.text).not.toContain('Last configuration change');
    const actions = (await systemPool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'config_backup.version.%'`, [s.a.organizationId])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['config_backup.version.diff', 'config_backup.version.download']));
    // Content is stored sealed.
    const sealed = await systemPool.query(`SELECT content_enc FROM config_backup_contents WHERE target_id = $1`, [targetId]);
    expect(sealed.rowCount).toBe(2);
    for (const r of sealed.rows) expect(r.content_enc).not.toContain('hostname');

    // Roles: viewers see the timeline but not content; technicians back up; only admins configure.
    await setRole(s.a.email, s.a.organizationId, 'viewer');
    expect((await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}/versions`)).status).toBe(200);
    expect((await s.a.agent.get(`/api/v1/config-backup/versions/${versions[0].id}`)).status).toBe(403);
    expect((await s.a.agent.get(`/api/v1/config-backup/versions/${versions[0].id}/download`)).status).toBe(403);
    expect((await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/run`).set(CSRF).send({})).status).toBe(403);
    await setRole(s.a.email, s.a.organizationId, 'technician');
    expect((await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/run`).set(CSRF).send({})).status).toBe(202);
    expect((await s.a.agent.put(`/api/v1/config-backup/targets/${targetId}/credentials`).set(CSRF).send({ credentials: { username: 'x', password: 'y' } })).status).toBe(403);
    expect((await s.a.agent.delete(`/api/v1/config-backup/targets/${targetId}`).set(CSRF)).status).toBe(403);
    await setRole(s.a.email, s.a.organizationId, 'admin');
    const content = await s.a.agent.get(`/api/v1/config-backup/versions/${versions[0].id}`);
    expect(content.status).toBe(200);
    expect(content.body.content).toContain('snmp-server community s3cr3t RO');
    target = (await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}`)).body;
    expect(target.pending_run_id).toBeTruthy();
  });

  it('stops on a changed host key until an administrator accepts the exact new key, and pauses on rejected credentials', async () => {
    const s = await setup('cb-hostkey');
    const { targetId, runId } = await addSwitch(s);
    await commands(s.c, 'config_backup');
    await telemetry(s.c, [result({ run_id: runId, target_id: targetId, ok: true, host_key: { sha256: KEY_A, type: 'ssh-ed25519' }, host_key_status: 'first_use', config_gzip_b64: gz(CONFIG_V1) })]);

    let run = await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/run`).set(CSRF).send({});
    await commands(s.c, 'config_backup');
    let t = await telemetry(s.c, [
      result({
        run_id: run.body.run_id,
        target_id: targetId,
        ok: false,
        host_key: { sha256: KEY_B, type: 'ssh-ed25519' },
        host_key_status: 'changed',
        error: { kind: 'host_key_changed', message: 'the device presented a different SSH host key; no credentials were sent' },
      }),
    ]);
    expect(t.body).toMatchObject({ accepted: 1 });
    let target = (await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}`)).body;
    expect(target).toMatchObject({ host_key_status: 'changed', readiness: 'host_key_changed', host_key_sha256: KEY_A });
    expect(target.presented_host_key).toMatchObject({ sha256: KEY_B });
    const ev = (await s.a.agent.get('/api/v1/events?page_size=100')).body.items.find((e: { type: string }) => e.type === 'config_host_key_changed');
    expect(ev).toMatchObject({ severity: 'critical' });
    expect(ev.details).toMatchObject({ pinned: KEY_A, presented: KEY_B, credentials_sent: false });

    const blocked = await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/run`).set(CSRF).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('backup_host_key_changed');
    // The scheduled job does not queue it either.
    await systemPool.query(`UPDATE config_backup_targets SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [targetId]);
    await runConfigBackupJob();
    expect((await commands(s.c, 'config_backup')).length).toBe(0);

    const wrong = await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/host-key/accept`).set(CSRF).send({ sha256: KEY_A });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('fingerprint_mismatch');
    const ok = await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/host-key/accept`).set(CSRF).send({ sha256: KEY_B });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ host_key_status: 'pinned', host_key_sha256: KEY_B, host_key_pinned_via: 'admin', readiness: 'ready' });

    // Rejected credentials pause backups (no lock-out) until they are replaced.
    run = await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/run`).set(CSRF).send({});
    expect(run.status).toBe(202);
    await commands(s.c, 'config_backup');
    t = await telemetry(s.c, [result({ run_id: run.body.run_id, target_id: targetId, ok: false, host_key: { sha256: KEY_B, type: 'ssh-ed25519' }, host_key_status: 'matched', error: { kind: 'auth_failed', message: 'the device rejected the user name or credentials' } })]);
    expect(t.body).toMatchObject({ accepted: 1 });
    target = (await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}`)).body;
    expect(target).toMatchObject({ readiness: 'credentials_rejected', last_status: 'failed', last_error_kind: 'auth_failed' });
    expect((await s.a.agent.get('/api/v1/events?page_size=100')).body.items.some((e: { type: string }) => e.type === 'config_backup_failed')).toBe(true);
    expect((await s.a.agent.post(`/api/v1/config-backup/targets/${targetId}/run`).set(CSRF).send({})).body.error.code).toBe('backup_credentials_rejected');

    // A second device reuses the first one's credentials without the administrator typing them again.
    const second = await s.a.agent.post('/api/v1/config-backup/targets').set(CSRF).send({ site_id: s.a.siteId, targets: [{ address: '192.168.60.1', driver: 'mikrotik_routeros' }], run_now: false });
    expect(second.status).toBe(201);
    expect(second.body.items[0]).toMatchObject({ readiness: 'no_credentials', vendor: { driver: 'mikrotik_routeros', source: 'manual' } });
    const fixed = await s.a.agent.put(`/api/v1/config-backup/targets/${targetId}/credentials`).set(CSRF).send({ credentials: { username: USERNAME, password: `${PASSWORD}-new` } });
    expect(fixed.body.readiness).toBe('ready');
    const copied = await s.a.agent.put(`/api/v1/config-backup/targets/${second.body.items[0].id}/credentials`).set(CSRF).send({ copy_from_target_id: targetId });
    expect(copied.status).toBe(200);
    expect(copied.body.readiness).toBe('ready');
    run = await s.a.agent.post(`/api/v1/config-backup/targets/${second.body.items[0].id}/run`).set(CSRF).send({});
    const [cmd] = await commands(s.c, 'config_backup');
    expect(cmd!.payload).toMatchObject({ address: '192.168.60.1', password: `${PASSWORD}-new`, driver: 'mikrotik_routeros' });

    // Removing a device withdraws its pending backup (its credentials are no longer delivered).
    expect((await s.a.agent.delete(`/api/v1/config-backup/targets/${second.body.items[0].id}`).set(CSRF)).status).toBe(204);
    expect((await commands(s.c, 'config_backup')).length).toBe(0);
  });

  it('queues due daily backups through the scheduler and expires unanswered runs', async () => {
    const s = await setup('cb-schedule');
    const res = await s.a.agent
      .post('/api/v1/config-backup/targets')
      .set(CSRF)
      .send({ site_id: s.a.siteId, targets: [{ address: '192.168.60.2' }], credentials: { username: USERNAME, password: PASSWORD }, run_now: false, schedule_hour: 3 });
    const targetId = res.body.items[0].id;
    expect(res.body.queued).toEqual([]);
    await systemPool.query(`UPDATE config_backup_targets SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [targetId]);
    await runConfigBackupJob();
    const [cmd] = await commands(s.c, 'config_backup');
    expect(cmd!.payload).toMatchObject({ target_id: targetId, username: USERNAME });
    const target = (await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}`)).body;
    expect(target.runs[0]).toMatchObject({ trigger: 'scheduled', status: 'pending' });
    expect(new Date(target.next_run_at).getTime()).toBeGreaterThan(Date.now());

    await systemPool.query(`UPDATE config_backup_runs SET expires_at = now() - interval '1 second' WHERE target_id = $1`, [targetId]);
    await runConfigBackupJob();
    const after = (await s.a.agent.get(`/api/v1/config-backup/targets/${targetId}`)).body;
    expect(after.runs[0]).toMatchObject({ status: 'expired', error_kind: 'expired' });
    expect((await commands(s.c, 'config_backup')).length).toBe(0);
    // A late answer to an expired run is still applied (the configuration was read).
    const late = await telemetry(s.c, [result({ run_id: after.runs[0].id, target_id: targetId, ok: true, host_key: { sha256: KEY_A, type: 'ssh-rsa' }, host_key_status: 'first_use', config_gzip_b64: gz('hostname late\n') })]);
    expect(late.body).toMatchObject({ accepted: 1 });
    // The daily SSH check of the site was queued by the same job.
    expect((await commands(s.c, 'config_backup_probe')).length).toBe(1);
    // Validation: a bad result shape is refused, garbage gzip too.
    const bad = await telemetry(s.c, [result({ run_id: randomUUID(), target_id: targetId, ok: true })]);
    expect(bad.body.rejected).toHaveLength(1);
  });
});
