import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openWithKey, sealWithKey } from '../src/common/secret-box.ts';
import { migrate } from '../src/database/migrate.ts';
import {
  exportDatabase,
  inspectBackup,
  openKeyEnvelope,
  pruneAutoBackups,
  RestoreNeedsKey,
  restoreLogicalBackup,
  sealKeyEnvelope,
  verifyBackupFile,
  WrongPassphrase,
} from '../src/ops/logical-backup.ts';
import { OpsRefused } from '../src/ops/backup.ts';
import { checkFolderShape, isDue, lastDue } from '../src/modules/backups/service.ts';
import { databaseExists, dropDatabase, scratchDatabase, withClient } from './ops-db.ts';

// Backups from the app (UX review item 15): the export / restore without pg_dump, against throw-away
// databases on the test PostgreSQL server; the schedule arithmetic; and the route gate.

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const PASS = 'correct horse battery';
const created: string[] = [];
let dir = '';

async function scratch(prefix: string, opts?: { migrate?: boolean }) {
  const d = await scratchDatabase(prefix, opts);
  created.push(d.name);
  return d;
}

/** One organization with a sealed MFA secret, rows with a bytea, a generated column, a bigserial, inet and arrays. */
async function seed(url: string, key: Buffer): Promise<{ org: string; user: string }> {
  return withClient(url, async (c) => {
    const org = (await c.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Home') RETURNING id`)).rows[0]!.id;
    const site = (await c.query<{ id: string }>(`INSERT INTO sites (organization_id, name) VALUES ($1, 'Flat') RETURNING id`, [org])).rows[0]!.id;
    const user = (await c.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ('owner@example.test', 'x', 'Owner') RETURNING id`)).rows[0]!.id;
    await c.query(`UPDATE users SET mfa_secret_enc = $2, mfa_enabled_at = now() WHERE id = $1`, [user, sealWithKey(key, 'TOTP-SECRET-1')]);
    // Rows whose parents are not seeded: loaded with triggers (foreign keys) off, as the restore does.
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    const collector = randomUUID();
    for (let i = 0; i < 3; i++) {
      await c.query(
        `INSERT INTO dns_stats (organization_id, site_id, collector_id, client_ip, window_start, window_end, queries, blocked, top_domains)
         VALUES ($1, $2, $3, '192.168.1.20', now(), now(), $4, 0, '[{"d":"example.com","n":3}]')`,
        [org, site, collector, 10 + i],
      );
    }
    const device = randomUUID();
    await c.query(
      `INSERT INTO device_addresses (device_id, organization_id, site_id, ip, sources, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, 'fe80::1', '{icmpv6,ndp_cache}', now(), now())`,
      [device, org, site],
    );
    await c.query(`INSERT INTO fleet_shell_transcript (shell_id, organization_id, seq, direction, at, ciphertext) VALUES ($1, $2, 0, 'o', now(), $3)`, [
      randomUUID(),
      org,
      Buffer.from([0, 1, 2, 255, 254]),
    ]);
    await c.query('COMMIT');
    return { org, user };
  });
}

const counts = (url: string) =>
  withClient(url, async (c) => {
    const one = async (t: string) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n);
    return { organizations: await one('organizations'), users: await one('users'), dns_stats: await one('dns_stats'), device_addresses: await one('device_addresses') };
  });

async function rewrite(file: string, out: string, edit: (lines: unknown[]) => unknown[]): Promise<void> {
  const lines: unknown[] = [];
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const l of rl) if (l) lines.push(JSON.parse(l));
  const gz = createGzip();
  const ws = createWriteStream(out);
  gz.pipe(ws);
  for (const l of edit(lines)) gz.write(`${JSON.stringify(l)}\n`);
  gz.end();
  await finished(ws);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'nigafiy-backup-ui-'));
});

afterAll(async () => {
  for (const name of created) await dropDatabase(name).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe('key envelope', () => {
  it('opens with the passphrase only', () => {
    const env = sealKeyEnvelope(KEY_A, PASS);
    expect(JSON.stringify(env)).not.toContain(KEY_A.toString('hex'));
    expect(openKeyEnvelope(env, PASS).equals(KEY_A)).toBe(true);
    expect(() => openKeyEnvelope(env, 'wrong passphrase!')).toThrow(WrongPassphrase);
    expect(() => sealKeyEnvelope(KEY_A, 'short')).toThrow(OpsRefused);
    expect(() => openKeyEnvelope({ ...env, n: 2 ** 22 }, PASS)).toThrow(/work factors/);
  });
});

describe('export and restore without pg_dump', () => {
  it('backs up, then restores in place after a change; the previous database is kept', async () => {
    const db = await scratch('bk_inplace');
    const { user } = await seed(db.ownerUrl, KEY_A);
    const before = await counts(db.ownerUrl);

    const r = await exportDatabase({ databaseUrl: db.ownerUrl, outDir: dir, kind: 'manual', currentKey: KEY_A, keyEnvelope: null, appVersion: '9.9.9' });
    expect(path.basename(r.file)).toMatch(/^nigafiy-\d{8}-\d{6}Z(-\d+)?-manual\.nigafiy-backup$/);
    expect(r.keyIncluded).toBe(false);
    expect(existsSync(`${r.file}.partial`)).toBe(false);
    const v = await verifyBackupFile(r.file);
    expect(v.rows).toBe(r.rows);
    expect(v.header.app_version).toBe('9.9.9');

    await withClient(db.ownerUrl, (c) => c.query(`DELETE FROM dns_stats; UPDATE users SET display_name = 'changed'`));
    const res = await restoreLogicalBackup({ databaseUrl: db.ownerUrl, appDatabaseUrl: db.appUrl, file: r.file, currentKey: KEY_A });
    created.push(res.previousDatabase);
    expect(res.keyRotated).toBe(false);
    expect(res.secretsReadable).toBe(true);
    expect(await counts(db.ownerUrl)).toEqual(before);
    expect(await databaseExists(res.previousDatabase)).toBe(true);

    await withClient(db.ownerUrl, async (c) => {
      const u = (await c.query<{ display_name: string; mfa_secret_enc: string }>('SELECT display_name, mfa_secret_enc FROM users WHERE id = $1', [user])).rows[0]!;
      expect(u.display_name).toBe('Owner');
      expect(openWithKey(KEY_A, u.mfa_secret_enc)).toBe('TOTP-SECRET-1');
      const t = (await c.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM fleet_shell_transcript')).rows[0]!;
      expect([...t.ciphertext]).toEqual([0, 1, 2, 255, 254]);
      const a = (await c.query<{ address_scope: string; sources: string[] }>('SELECT address_scope, sources FROM device_addresses')).rows[0]!;
      expect(a).toEqual({ address_scope: 'link_local', sources: ['icmpv6', 'ndp_cache'] });
      // The sequence continues after the restored rows.
      const next = (await c.query<{ id: string }>(
        `INSERT INTO dns_stats (organization_id, site_id, collector_id, client_ip, window_start, window_end, queries, blocked)
         SELECT organization_id, site_id, collector_id, client_ip, now(), now(), 1, 0 FROM dns_stats LIMIT 1 RETURNING id`,
      )).rows[0]!;
      const max = (await c.query<{ m: string }>('SELECT max(id) AS m FROM dns_stats WHERE id <> $1', [next.id])).rows[0]!;
      expect(Number(next.id)).toBeGreaterThan(Number(max.m));
      // The restore is in the audit log.
      const audit = await c.query(`SELECT metadata FROM audit_logs WHERE action = 'database.restored'`);
      expect(audit.rowCount).toBe(1);
    });
  });

  it('moves to a PC with another key: asks for the passphrase, then re-encrypts the secrets', async () => {
    const src = await scratch('bk_src');
    const { user } = await seed(src.ownerUrl, KEY_A);
    const r = await exportDatabase({ databaseUrl: src.ownerUrl, outDir: dir, kind: 'manual', currentKey: KEY_A, keyEnvelope: sealKeyEnvelope(KEY_A, PASS), appVersion: '1' });
    expect(r.keyIncluded).toBe(true);
    const target = await scratch('bk_target');

    const info = await inspectBackup(r.file, KEY_B);
    expect(info).toMatchObject({ sameKey: false, needsPassphrase: true, keyMissing: false, newerVersion: false });

    const base = { databaseUrl: target.ownerUrl, appDatabaseUrl: target.appUrl, file: r.file, currentKey: KEY_B };
    await expect(restoreLogicalBackup(base)).rejects.toMatchObject({ reason: 'passphrase_needed' });
    await expect(restoreLogicalBackup({ ...base, passphrase: 'not the passphrase' })).rejects.toBeInstanceOf(WrongPassphrase);
    expect((await counts(target.ownerUrl)).organizations).toBe(0);

    const res = await restoreLogicalBackup({ ...base, passphrase: PASS });
    created.push(res.previousDatabase);
    expect(res.keyRotated).toBe(true);
    await withClient(target.ownerUrl, async (c) => {
      const u = (await c.query<{ mfa_secret_enc: string }>('SELECT mfa_secret_enc FROM users WHERE id = $1', [user])).rows[0]!;
      expect(openWithKey(KEY_B, u.mfa_secret_enc)).toBe('TOTP-SECRET-1');
    });
  });

  it('a stale envelope (made for an older key) is left out of the backup', async () => {
    const db = await scratch('bk_stale');
    const r = await exportDatabase({ databaseUrl: db.ownerUrl, outDir: dir, kind: 'manual', currentKey: KEY_B, keyEnvelope: sealKeyEnvelope(KEY_A, PASS), appVersion: '1' });
    expect(r.keyIncluded).toBe(false);
  });

  it('without the key: refused unless the owner accepts that stored passwords are lost', async () => {
    const src = await scratch('bk_nokey');
    await seed(src.ownerUrl, KEY_A);
    const r = await exportDatabase({ databaseUrl: src.ownerUrl, outDir: dir, kind: 'manual', currentKey: KEY_A, keyEnvelope: null, appVersion: '1' });
    const target = await scratch('bk_nokey_t');
    const base = { databaseUrl: target.ownerUrl, appDatabaseUrl: target.appUrl, file: r.file, currentKey: KEY_B };
    const err = await restoreLogicalBackup(base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreNeedsKey);
    expect((err as RestoreNeedsKey).reason).toBe('key_missing');
    const res = await restoreLogicalBackup({ ...base, allowUnreadableSecrets: true });
    created.push(res.previousDatabase);
    expect(res.secretsReadable).toBe(false);
    expect((await counts(target.ownerUrl)).users).toBe(1);
  });

  it('restores a backup from an older version and runs the newer migrations; refuses a newer one', async () => {
    const files = (await readdir(path.resolve(import.meta.dirname, '../src/database/migrations'))).filter((f) => f.endsWith('.sql')).sort();
    const last = files.at(-1)!;
    const old = await scratch('bk_old', { migrate: false });
    await migrate(old.ownerUrl, old.appUrl, () => undefined, { stopBefore: last });
    await withClient(old.ownerUrl, (c) => c.query(`INSERT INTO organizations (name) VALUES ('Old')`));
    const r = await exportDatabase({ databaseUrl: old.ownerUrl, outDir: dir, kind: 'manual', currentKey: KEY_A, keyEnvelope: null, appVersion: '0.9' });

    const target = await scratch('bk_old_t');
    const res = await restoreLogicalBackup({ databaseUrl: target.ownerUrl, appDatabaseUrl: target.appUrl, file: r.file, currentKey: KEY_A });
    created.push(res.previousDatabase);
    expect(res.migrationsApplied).toEqual([last]);
    expect((await counts(target.ownerUrl)).organizations).toBe(1);

    const newer = path.join(dir, 'newer.nigafiy-backup');
    await rewrite(r.file, newer, (lines) => {
      const h = lines[0] as { migrations: string[] };
      h.migrations = [...files, '999_future.sql'];
      return lines;
    });
    expect((await inspectBackup(newer, KEY_A)).newerVersion).toBe(true);
    await expect(restoreLogicalBackup({ databaseUrl: target.ownerUrl, appDatabaseUrl: target.appUrl, file: newer, currentKey: KEY_A })).rejects.toThrow(/newer version/);
  });

  it('refuses an incomplete or foreign file, and changes nothing', async () => {
    const db = await scratch('bk_bad');
    await withClient(db.ownerUrl, (c) => c.query(`INSERT INTO organizations (name) VALUES ('Keep')`));
    const r = await exportDatabase({ databaseUrl: db.ownerUrl, outDir: dir, kind: 'manual', currentKey: KEY_A, keyEnvelope: null, appVersion: '1' });
    const cut = path.join(dir, 'cut.nigafiy-backup');
    await rewrite(r.file, cut, (lines) => lines.slice(0, -1));
    await expect(verifyBackupFile(cut)).rejects.toThrow(/incomplete/);
    const opts = { databaseUrl: db.ownerUrl, appDatabaseUrl: db.appUrl, currentKey: KEY_A };
    await expect(restoreLogicalBackup({ ...opts, file: cut })).rejects.toThrow(/incomplete/);
    const foreign = path.join(dir, 'foreign.nigafiy-backup');
    await writeFile(foreign, 'hello');
    await expect(restoreLogicalBackup({ ...opts, file: foreign })).rejects.toBeInstanceOf(OpsRefused);
    expect((await counts(db.ownerUrl)).organizations).toBe(1);
  });
});

describe('the folder', () => {
  it('keeps the newest scheduled backups and never removes "Back up now" files', async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'nigafiy-prune-'));
    const names = [
      'nigafiy-20261101-030000Z-auto.nigafiy-backup',
      'nigafiy-20261102-030000Z-auto.nigafiy-backup',
      'nigafiy-20261103-030000Z-auto.nigafiy-backup',
      'nigafiy-20261101-120000Z-manual.nigafiy-backup',
      'notes.txt',
    ];
    for (const n of names) await writeFile(path.join(d, n), 'x');
    expect(await pruneAutoBackups(d, 2)).toEqual(['nigafiy-20261101-030000Z-auto.nigafiy-backup']);
    expect((await readdir(d)).sort()).toEqual(names.slice(1).sort());
    await rm(d, { recursive: true, force: true });
  });

  it('accepts only absolute local folders', () => {
    expect(checkFolderShape('\\\\nas\\share')).toBe('network');
    expect(checkFolderShape('//nas/share')).toBe('network');
    expect(checkFolderShape('backups')).toBe('relative');
    expect(checkFolderShape(process.platform === 'win32' ? 'D:\\Nigafiy backups' : '/srv/backups')).toBeNull();
  });
});

describe('schedule', () => {
  const at = (s: string) => new Date(s);
  it('daily: due once per day at the hour, and catches up after the PC was off', () => {
    const s = { schedule: 'daily' as const, hour: 3, weekday: 0 };
    expect(lastDue(s, at('2026-11-26T10:00:00'))).toEqual(at('2026-11-26T03:00:00'));
    expect(lastDue(s, at('2026-11-26T02:00:00'))).toEqual(at('2026-11-25T03:00:00'));
    expect(isDue({ ...s, last_auto_at: null }, at('2026-11-26T10:00:00'))).toBe(true);
    expect(isDue({ ...s, last_auto_at: at('2026-11-26T03:05:00') }, at('2026-11-26T10:00:00'))).toBe(false);
    expect(isDue({ ...s, last_auto_at: at('2026-11-24T03:05:00') }, at('2026-11-26T10:00:00'))).toBe(true);
  });
  it('weekly: the latest chosen weekday', () => {
    // 2026-11-26 is a Thursday (4); Sunday 2026-11-22.
    expect(lastDue({ schedule: 'weekly', hour: 3, weekday: 0 }, at('2026-11-26T10:00:00'))).toEqual(at('2026-11-22T03:00:00'));
    expect(lastDue({ schedule: 'weekly', hour: 12, weekday: 4 }, at('2026-11-26T10:00:00'))).toEqual(at('2026-11-19T12:00:00'));
    expect(lastDue({ schedule: 'off', hour: 3, weekday: 0 }, at('2026-11-26T10:00:00'))).toBeNull();
  });
});

describe('routes', () => {
  it('are owner-only and off on an installation with several organizations', async () => {
    const { app, CSRF, newAccount } = await import('./helpers.ts');
    const owner = await newAccount('bk');
    await newAccount('bk2'); // a second organization: this is not a single-organization installation
    const status = await owner.agent.get('/api/v1/backups');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ available: false });
    const run = await owner.agent.post('/api/v1/backups/run').set(CSRF);
    expect(run.status).toBe(403);
    expect(run.body.error.code).toBe('dbbackup_unavailable');
    expect((await request(app).get('/api/v1/backups')).status).toBe(401);
  });
});
