import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { CSRF, addScope, heartbeat, newAccount, newCollector, setRole, type TestCollector, telemetry } from './helpers.ts';

// Administrator-confirmed configuration restore (modules/configbackup/restore.ts). The collector side
// (Junos commit confirmed, read-back) is tested in Go against an SSH test double; here the API: roles,
// typed confirmation, the honest "not supported", the backup first, the command with its secrets only
// in the heartbeat answer, the verification against the read-back, failures, and the audit trail.

const PASSWORD = 'Junos-Restore-Secret-31';
const KEY = `SHA256:${'Q'.repeat(43)}`;
const ROOT_HASH = '$6$abcdefgh$RealRootHashThatMustOnlyReachTheCollector';

const junos = (hostName: string, extra = '') =>
  [
    '## Last commit: 2026-11-21 10:00:00 UTC by admin',
    'version 21.4R3;',
    'system {',
    `    host-name ${hostName};`,
    '    root-authentication {',
    `        encrypted-password "${ROOT_HASH}";`,
    '    }',
    '}',
    'interfaces {',
    '    ge-0/0/0 {',
    `        description "${extra || 'uplink'}";`,
    '    }',
    '}',
    '',
  ].join('\n');
const V1 = junos('edge-srx', 'uplink');
const V2 = junos('edge-srx', 'uplink to the new ISP');

const gz = (text: string) => gzipSync(Buffer.from(text, 'utf8')).toString('base64');
const now = () => new Date().toISOString();

async function commands(c: TestCollector, kind: string) {
  const hb = await heartbeat(c);
  expect(hb.status).toBe(200);
  return (hb.body.commands as { id: string; kind: string; payload: Record<string, unknown> }[]).filter((x) => x.kind === kind);
}

async function backup(c: TestCollector, runId: string, targetId: string, config: string) {
  const t = await telemetry(c, [
    {
      type: 'config_backup_result',
      ts: now(),
      run_id: runId,
      target_id: targetId,
      ok: true,
      duration_ms: 900,
      host_key: { sha256: KEY, type: 'ssh-ed25519' },
      host_key_status: 'matched',
      commands: ['show configuration | no-more'],
      config_gzip_b64: gz(config),
    },
  ]);
  expect(t.body).toMatchObject({ accepted: 1 });
}

const restoreOf = (a: { agent: import('supertest').Agent }, id: string) => a.agent.get(`/api/v1/config-backup/restores/${id}`);

const ios = (hostname: string, desc: string) => `version 17.9
hostname ${hostname}
!
enable secret 9 ${ROOT_HASH}
!
archive
 path bootflash:archive
!
interface GigabitEthernet1
 description ${desc}
!
end
`;

describe('configuration restore', () => {
  it('offers Cisco IOS XE configure replace and refuses the configuration of another device unless forced with a second confirmation', async () => {
    const a = await newAccount('cb-restore-ios');
    await addScope(a, '192.168.71.0/24');
    const c = await newCollector(a);
    await heartbeat(c);
    const added = await a.agent
      .post('/api/v1/config-backup/targets')
      .set(CSRF)
      .send({ site_id: a.siteId, targets: [{ address: '192.168.71.1', name: 'edge-isr', driver: 'cisco_ios' }], credentials: { username: 'netops', password: PASSWORD } });
    expect(added.status).toBe(201);
    const id = added.body.items[0].id as string;
    await backup(c, added.body.queued[0].run_id, id, ios('old-branch-rtr', 'uplink'));
    const run2 = await a.agent.post(`/api/v1/config-backup/targets/${id}/run`).set(CSRF).send({});
    await backup(c, run2.body.run_id, id, ios('edge-isr', 'uplink'));
    const versions = (await a.agent.get(`/api/v1/config-backup/targets/${id}/versions`)).body.items as { id: string; number: number }[];
    const v1 = versions.find((v) => v.number === 1)!;

    const preview = await a.agent.get(`/api/v1/config-backup/targets/${id}/restore-preview?version_id=${v1.id}`);
    expect(preview.body).toMatchObject({ supported: true, possible: true, method: 'iosxe_configure_replace', other_device: { current: 'edge-isr', version: 'old-branch-rtr' } });

    const req = (body: Record<string, unknown>) => a.agent.post(`/api/v1/config-backup/targets/${id}/restore`).set(CSRF).send({ version_id: v1.id, confirm: 'edge-isr', reason: 'Back to the branch router configuration', ...body });
    const refused = await req({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('other_device');
    const wrong = await req({ force_other_device: true, confirm_other_device: 'edge-isr' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('confirm_other_device_mismatch');
    expect(await commands(c, 'config_backup')).toHaveLength(0);

    const ok = await req({ force_other_device: true, confirm_other_device: 'old-branch-rtr', confirm_minutes: 2 });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ status: 'pre_backup', method: 'iosxe_configure_replace', confirm_minutes: 2 });
    await backup(c, ok.body.pre_run_id, id, ios('edge-isr', 'uplink'));
    const [cmd] = await commands(c, 'config_restore');
    expect(cmd!.payload).toMatchObject({ driver: 'cisco_ios', confirm_minutes: 2 });
    expect(gunzipSync(Buffer.from(cmd!.payload.config_gzip_b64 as string, 'base64')).toString('utf8')).toContain('hostname old-branch-rtr');
    const audit = (await systemPool.query(`SELECT metadata FROM audit_logs WHERE organization_id = $1 AND action = 'config_backup.restore.request'`, [a.organizationId])).rows[0];
    expect(audit.metadata.other_device).toEqual({ current: 'edge-isr', version: 'old-branch-rtr' });
  });

  it('restores a Junos version after a fresh backup, verifies it by the read-back, and audits every step', async () => {
    const a = await newAccount('cb-restore');
    await addScope(a, '192.168.70.0/24');
    const c = await newCollector(a);
    await heartbeat(c);

    const added = await a.agent
      .post('/api/v1/config-backup/targets')
      .set(CSRF)
      .send({
        site_id: a.siteId,
        targets: [
          { address: '192.168.70.1', name: 'edge-srx', driver: 'juniper_junos' },
          { address: '192.168.70.2', name: 'core-sw', driver: 'cisco_asa' },
        ],
        credentials: { username: 'netops', password: PASSWORD },
      });
    expect(added.status).toBe(201);
    const srx = added.body.items.find((t: { name: string }) => t.name === 'edge-srx').id as string;
    const sw = added.body.items.find((t: { name: string }) => t.name === 'core-sw').id as string;
    const firstRun = (id: string) => added.body.queued.find((q: { target_id: string }) => q.target_id === id).run_id as string;

    // Two backups of each device: versions 1 and 2 (raw copies sealed for restore).
    await backup(c, firstRun(srx), srx, V1);
    await backup(c, firstRun(sw), sw, 'hostname core-sw\ninterface Gi0/1\n description a\nend\n');
    const run2 = await a.agent.post(`/api/v1/config-backup/targets/${srx}/run`).set(CSRF).send({});
    expect(run2.status).toBe(202);
    await backup(c, run2.body.run_id, srx, V2);
    const versions = (await a.agent.get(`/api/v1/config-backup/targets/${srx}/versions`)).body.items as { id: string; number: number; sha256: string }[];
    const v1 = versions.find((v) => v.number === 1)!;
    const v2 = versions.find((v) => v.number === 2)!;
    expect(v2).toBeDefined();

    // Roles: preview and restore are for owner / admin only.
    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.get(`/api/v1/config-backup/targets/${srx}/restore-preview?version_id=${v1.id}`)).status).toBe(403);
    expect((await a.agent.post(`/api/v1/config-backup/targets/${srx}/restore`).set(CSRF).send({ version_id: v1.id, confirm: 'edge-srx', reason: 'Roll back the ISP change' })).status).toBe(403);
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get(`/api/v1/config-backup/targets/${srx}/restores`)).status).toBe(200);
    await setRole(a.email, a.organizationId, 'admin');

    // Preview: the diff from the latest backup (v2) to v1, with the device name to type.
    const preview = await a.agent.get(`/api/v1/config-backup/targets/${srx}/restore-preview?version_id=${v1.id}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ possible: true, supported: true, method: 'junos_commit_confirmed', confirm_text: 'edge-srx', blocker: null });
    expect(preview.body.current.number).toBe(2);
    expect(preview.body.added).toBe(1);
    expect(preview.body.removed).toBe(1);
    expect(JSON.stringify(preview.body)).not.toContain(ROOT_HASH); // the preview diff is the sanitized text

    // Honest "not supported" for other vendors, at preview and at request.
    const swVersion = (await a.agent.get(`/api/v1/config-backup/targets/${sw}/versions`)).body.items[0].id;
    const swPreview = await a.agent.get(`/api/v1/config-backup/targets/${sw}/restore-preview?version_id=${swVersion}`);
    expect(swPreview.body).toMatchObject({ supported: false, possible: false, method: null });
    expect(swPreview.body.blocker.code).toBe('restore_unsupported');
    expect(swPreview.body.blocker.message).toContain('Cisco ASA');
    const swRestore = await a.agent.post(`/api/v1/config-backup/targets/${sw}/restore`).set(CSRF).send({ version_id: swVersion, confirm: 'core-sw', reason: 'Roll back the change' });
    expect(swRestore.status).toBe(409);
    expect(swRestore.body.error.code).toBe('restore_unsupported');

    // Validation: typed name, reason, minutes, a version of this device.
    const bad = (body: Record<string, unknown>) => a.agent.post(`/api/v1/config-backup/targets/${srx}/restore`).set(CSRF).send(body);
    const mismatch = await bad({ version_id: v1.id, confirm: 'edge-sr', reason: 'Roll back the ISP change' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('confirm_mismatch');
    expect((await bad({ version_id: v1.id, confirm: 'edge-srx', reason: 'short' })).status).toBe(400);
    expect((await bad({ version_id: v1.id, confirm: 'edge-srx', reason: 'Roll back the ISP change', confirm_minutes: 30 })).status).toBe(400);
    expect((await bad({ version_id: swVersion, confirm: 'edge-srx', reason: 'Roll back the ISP change' })).status).toBe(422);
    expect((await bad({ version_id: v2.id, confirm: 'edge-srx', reason: 'Roll back the ISP change' })).body.error.code).toBe('already_current');

    // The request: a backup runs first, nothing is sent to the device yet.
    const req1 = await bad({ version_id: v1.id, confirm: 'edge-srx', reason: 'Roll back the ISP change', confirm_minutes: 3 });
    expect(req1.status).toBe(202);
    expect(req1.body).toMatchObject({ status: 'pre_backup', version_number: 1, confirm_minutes: 3, method: 'junos_commit_confirmed' });
    const restoreId = req1.body.id as string;
    expect((await bad({ version_id: v1.id, confirm: 'edge-srx', reason: 'Roll back the ISP change' })).body.error.code).toBe('restore_in_progress');
    const pre = await commands(c, 'config_backup');
    expect(pre.map((x) => x.payload.run_id)).toEqual([req1.body.pre_run_id]);
    expect(await commands(c, 'config_restore')).toHaveLength(0);

    // The backup before the restore succeeds (device still at v2): the restore command is queued.
    await backup(c, req1.body.pre_run_id, srx, V2);
    let r = (await restoreOf(a, restoreId)).body;
    expect(r.status).toBe('pending');
    expect(r.verify_run_id).toBeTruthy();
    const [cmd] = await commands(c, 'config_restore');
    expect(cmd).toBeDefined();
    expect(cmd!.payload).toMatchObject({
      restore_id: restoreId,
      verify_run_id: r.verify_run_id,
      target_id: srx,
      address: '192.168.70.1',
      username: 'netops',
      password: PASSWORD,
      host_key_sha256: KEY,
      driver: 'juniper_junos',
      confirm_minutes: 3,
    });
    // The real (unsanitized) v1 text goes to the collector, and only there.
    const pushed = gunzipSync(Buffer.from(cmd!.payload.config_gzip_b64 as string, 'base64')).toString('utf8');
    expect(pushed).toContain(ROOT_HASH);
    expect(pushed).toContain('description "uplink";');
    const stored = await systemPool.query(`SELECT payload::text AS p FROM collector_commands WHERE id = $1`, [cmd!.id]);
    expect(stored.rows[0].p).not.toContain(PASSWORD);
    expect(stored.rows[0].p).not.toContain('config_gzip_b64');

    // The collector reports the read-back (as the verification backup), then the restore.
    await backup(c, r.verify_run_id, srx, V1);
    const result = {
      type: 'config_restore_result',
      ts: now(),
      restore_id: restoreId,
      target_id: srx,
      ok: true,
      duration_ms: 42_000,
      method: 'junos_commit_confirmed',
      loaded: true,
      committed: true,
      confirmed: true,
      rolled_back: false,
      read_back: true,
      steps: ['configure exclusive: configuration locked', 'load override terminal: load complete', 'commit confirmed 3: committed', 'commit: confirmed'],
    };
    expect((await telemetry(c, [result])).body).toMatchObject({ accepted: 1 });
    expect((await telemetry(c, [result])).body.rejected).toHaveLength(1); // answered once
    r = (await restoreOf(a, restoreId)).body;
    expect(r).toMatchObject({ status: 'verified', committed: true, confirmed: true, rolled_back: false, error: null });
    expect(r.steps).toHaveLength(4);
    const after = (await systemPool.query(`SELECT sha256 FROM config_backup_versions WHERE id = $1`, [r.after_version_id])).rows[0];
    expect(after.sha256).toBe(v1.sha256);

    const actions = (await systemPool.query(`SELECT action, actor FROM audit_logs WHERE organization_id = $1 AND action LIKE 'config_backup.restore.%' ORDER BY created_at`, [a.organizationId])).rows;
    expect(actions.map((x) => x.action)).toEqual(['config_backup.restore.preview', 'config_backup.restore.preview', 'config_backup.restore.request', 'config_backup.restore.result']);
    expect(actions.at(-1)!.actor).toBe('collector');
    const audits = await systemPool.query(`SELECT metadata::text AS m FROM audit_logs WHERE organization_id = $1`, [a.organizationId]);
    for (const row of audits.rows) {
      expect(row.m).not.toContain(PASSWORD);
      expect(row.m).not.toContain(ROOT_HASH);
    }
    const ev = await systemPool.query(`SELECT type, details FROM network_events WHERE organization_id = $1 AND type LIKE 'config_restore%'`, [a.organizationId]);
    expect(ev.rows.map((e) => e.type)).toEqual(['config_restored']);

    // A failed restore that put the previous configuration back: rolled_back, the verification run fails.
    const req2 = await bad({ version_id: v2.id, confirm: 'edge-srx', reason: 'Back to the ISP change again' });
    expect(req2.status).toBe(202);
    await backup(c, req2.body.pre_run_id, srx, V1);
    const pending2 = (await restoreOf(a, req2.body.id)).body;
    expect(pending2.status).toBe('pending');
    const failed = await telemetry(c, [
      {
        type: 'config_restore_result',
        ts: now(),
        restore_id: req2.body.id,
        target_id: srx,
        ok: false,
        method: 'junos_commit_confirmed',
        loaded: true,
        committed: true,
        confirmed: false,
        rolled_back: true,
        read_back: false,
        steps: ['commit confirmed 5: committed', 'rollback 1 + commit: previous configuration active again'],
        error: { kind: 'command_failed', message: 'after the commit the device could not be read over a new SSH session; the previous configuration was put back' },
      },
    ]);
    expect(failed.body).toMatchObject({ accepted: 1 });
    const r2 = (await restoreOf(a, req2.body.id)).body;
    expect(r2).toMatchObject({ status: 'rolled_back', rolled_back: true, confirmed: false, error_kind: 'command_failed' });
    const verify2 = (await systemPool.query(`SELECT status FROM config_backup_runs WHERE id = $1`, [pending2.verify_run_id])).rows[0];
    expect(verify2.status).toBe('failed');

    // The backup before the restore fails: the restore stops, nothing is sent to the device.
    const req3 = await bad({ version_id: v2.id, confirm: 'edge-srx', reason: 'Third attempt at the change' });
    expect(req3.status).toBe(202);
    const t3 = await telemetry(c, [
      {
        type: 'config_backup_result',
        ts: now(),
        run_id: req3.body.pre_run_id,
        target_id: srx,
        ok: false,
        host_key: { sha256: KEY, type: 'ssh-ed25519' },
        error: { kind: 'unreachable', message: 'connection refused' },
      },
    ]);
    expect(t3.body).toMatchObject({ accepted: 1 });
    const r3 = (await restoreOf(a, req3.body.id)).body;
    expect(r3.status).toBe('failed');
    expect(r3.error_kind).toBe('pre_backup_failed');
    expect(r3.error).toContain('Nothing was changed');
    expect(await commands(c, 'config_restore')).toHaveLength(0);

    const list = await a.agent.get(`/api/v1/config-backup/targets/${srx}/restores`);
    expect(list.body.items.map((x: { status: string }) => x.status)).toEqual(['failed', 'rolled_back', 'verified']);
  });

  it('withdraws a pending restore when the credentials were removed, and expires a restore whose backup never reported', async () => {
    const a = await newAccount('cb-restore-2');
    await addScope(a, '192.168.71.0/24');
    const c = await newCollector(a);
    await heartbeat(c);
    const added = await a.agent
      .post('/api/v1/config-backup/targets')
      .set(CSRF)
      .send({ site_id: a.siteId, targets: [{ address: '192.168.71.1', name: 'srx-b', driver: 'juniper_junos' }], credentials: { username: 'netops', password: PASSWORD } });
    const id = added.body.items[0].id as string;
    await backup(c, added.body.queued[0].run_id, id, V1);
    const run2 = await a.agent.post(`/api/v1/config-backup/targets/${id}/run`).set(CSRF).send({});
    await backup(c, run2.body.run_id, id, V2);
    const v1 = (await a.agent.get(`/api/v1/config-backup/targets/${id}/versions`)).body.items.find((v: { number: number }) => v.number === 1).id;

    const req1 = await a.agent.post(`/api/v1/config-backup/targets/${id}/restore`).set(CSRF).send({ version_id: v1, confirm: 'srx-b', reason: 'Undo the description change' });
    expect(req1.status).toBe(202);
    await backup(c, req1.body.pre_run_id, id, V2);
    expect((await restoreOf(a, req1.body.id)).body.status).toBe('pending');
    // The device's credentials are marked rejected meanwhile: the restore must not be delivered.
    await systemPool.query(`UPDATE config_backup_targets SET credentials_rejected = true WHERE id = $1`, [id]);
    expect(await commands(c, 'config_restore')).toHaveLength(0);
    const w = (await restoreOf(a, req1.body.id)).body;
    expect(w).toMatchObject({ status: 'failed', error_kind: 'withdrawn' });
    await systemPool.query(`UPDATE config_backup_targets SET credentials_rejected = false WHERE id = $1`, [id]);

    const req2 = await a.agent.post(`/api/v1/config-backup/targets/${id}/restore`).set(CSRF).send({ version_id: v1, confirm: 'srx-b', reason: 'Undo the description change' });
    expect(req2.status).toBe(202);
    await systemPool.query(`UPDATE config_backup_restores SET expires_at = now() - interval '1 minute' WHERE id = $1`, [req2.body.id]);
    const e = (await restoreOf(a, req2.body.id)).body;
    expect(e.status).toBe('expired');
    expect(e.error).toContain('Nothing was changed');
    const actions = (await systemPool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'config_backup.restore.%'`, [a.organizationId])).rows.map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['config_backup.restore.withdrawn', 'config_backup.restore.expired']));
  });
});
