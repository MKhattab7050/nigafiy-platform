import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDatabase, OpsRefused, type ResolvedTool, resolveTool, restoreDatabase, swapInRestoredDatabase } from '../src/ops/backup.ts';
import { adminQuery, databaseExists, databasesLike, dropDatabase, maintenanceUrl, scratchDatabase, withClient } from './ops-db.ts';

// Backup / restore against the real test PostgreSQL server, in throw-away databases only.
//
// Every guard and every database step (confirm, live-session refusal, the rename swap and its
// recovery) runs on every machine. Only the steps that execute pg_dump / pg_restore need the
// PostgreSQL client tools, which embedded-postgres does not ship: those tests are skipped — and say
// so — when the tools are not installed (see docs/operations/backup-restore-and-key-rotation.md).

const created: string[] = [];
let scratchDir = '';
let serverMajor = 0;
let tools: { pgDump: ResolvedTool; pgRestore: ResolvedTool } | null = null;
let toolsMissing = '';

async function scratch(prefix: string, opts?: { migrate?: boolean }) {
  const d = await scratchDatabase(prefix, opts);
  created.push(d.name);
  return d;
}

async function marker(url: string): Promise<string | null> {
  return withClient(url, async (c) => {
    const exists = await c.query(`SELECT to_regclass('public.marker') AS t`);
    if (!exists.rows[0].t) return null;
    return (await c.query<{ v: string }>('SELECT v FROM marker')).rows[0]?.v ?? null;
  });
}

const allowConn = async (name: string) => (await adminQuery<{ a: boolean }>('SELECT datallowconn AS a FROM pg_database WHERE datname = $1', [name])).rows[0]?.a;

beforeAll(async () => {
  scratchDir = await mkdtemp(path.join(os.tmpdir(), 'ld-backup-test-'));
  serverMajor = Math.floor(Number((await adminQuery<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v) / 10_000);
  try {
    const pgDump = resolveTool('pg_dump', serverMajor);
    tools = { pgDump, pgRestore: resolveTool('pg_restore', serverMajor, path.dirname(pgDump.path)) };
  } catch (err) {
    toolsMissing = (err as Error).message;
    console.warn(
      `[backup-restore.test] SKIPPING the pg_dump/pg_restore steps: PostgreSQL ${serverMajor} client tools were not found on this machine ` +
        '(embedded-postgres ships only the server). Install them or set NIGAFIY_PG_BIN_DIR to run those tests. All guard and swap tests still run.',
    );
  }
});

afterAll(async () => {
  for (const name of created) {
    for (const n of await databasesLike(name)) await dropDatabase(n);
  }
  if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
});

describe('tool discovery', () => {
  it('refuses with installation instructions when pg_dump is not in the given folder', async () => {
    const empty = await mkdtemp(path.join(scratchDir, 'no-tools-'));
    let err: unknown;
    try {
      resolveTool('pg_dump', serverMajor, empty);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OpsRefused);
    expect((err as Error).message).toContain(`pg_dump ${serverMajor} or newer was not found in ${empty}`);
    expect((err as Error).message).toMatch(/embedded PostgreSQL package ships only the server/);
    expect((err as Error).message).toMatch(/NIGAFIY_PG_BIN_DIR/);
  });

  it('backupDatabase refuses (and writes nothing) when the client tools are missing', async () => {
    const d = await scratch('bk_notools', { migrate: false });
    const empty = await mkdtemp(path.join(scratchDir, 'no-tools-'));
    const out = path.join(scratchDir, 'out-notools');
    expect(serverMajor).toBeGreaterThanOrEqual(13);
    const err = await backupDatabase({ databaseUrl: d.ownerUrl, binDir: empty, outDir: out }).catch((e) => e);
    expect(err).toBeInstanceOf(OpsRefused);
    // The server's major version is read correctly (it decides which pg_dump is acceptable).
    expect(err.message).toContain(`pg_dump ${serverMajor} or newer was not found`);
  });
});

describe('restore guards (no client tools needed)', () => {
  it('requires --confirm to repeat the database name', async () => {
    const d = await scratch('rs_confirm', { migrate: false });
    const file = path.join(scratchDir, 'whatever.dump');
    await writeFile(file, 'not used');
    await expect(restoreDatabase({ databaseUrl: d.ownerUrl, file, confirm: undefined })).rejects.toThrow(new RegExp(`Repeat its name to confirm: --confirm ${d.name}`));
    await expect(restoreDatabase({ databaseUrl: d.ownerUrl, file, confirm: 'lan_detective' })).rejects.toBeInstanceOf(OpsRefused);
  });

  it('refuses a missing backup file', async () => {
    const d = await scratch('rs_nofile', { migrate: false });
    await expect(restoreDatabase({ databaseUrl: d.ownerUrl, file: path.join(scratchDir, 'missing.dump'), confirm: d.name })).rejects.toThrow(/Backup file not found/);
  });

  it('refuses while the API (or anything) is connected, and changes nothing', async () => {
    const d = await scratch('rs_live', { migrate: false });
    await withClient(d.ownerUrl, (c) => c.query(`CREATE TABLE marker (v text); INSERT INTO marker VALUES ('original')`));
    const file = path.join(scratchDir, 'live.dump');
    await writeFile(file, 'not used');
    const api = new pg.Client({ connectionString: d.ownerUrl, application_name: 'ld-app' });
    await api.connect();
    try {
      const err = await restoreDatabase({ databaseUrl: d.ownerUrl, file, confirm: d.name }).catch((e) => e);
      expect(err).toBeInstanceOf(OpsRefused);
      expect(err.message).toMatch(/1 session\(s\) are connected/);
      expect(err.message).toMatch(/The API is running/);
      expect(err.message).toMatch(/Nothing was changed/);
    } finally {
      await api.end();
    }
    expect(await marker(d.ownerUrl)).toBe('original');
    expect(await databasesLike(`${d.name}_`)).toEqual([]);
  });
});

describe('swapInRestoredDatabase (rename swap, outside a transaction block)', () => {
  async function pair(prefix: string) {
    const live = await scratch(prefix, { migrate: false });
    const restored = await scratch(`${prefix}_r`, { migrate: false });
    await withClient(live.ownerUrl, (c) => c.query(`CREATE TABLE marker (v text); INSERT INTO marker VALUES ('original')`));
    await withClient(restored.ownerUrl, (c) => c.query(`CREATE TABLE marker (v text); INSERT INTO marker VALUES ('restored')`));
    const previous = `${live.name}_prev`;
    created.push(previous);
    return { live, restored, previous };
  }

  it('swaps the restored database in and keeps the previous one, both accepting connections', async () => {
    const { live, restored, previous } = await pair('sw_ok');
    const terminated = await withClient(maintenanceUrl(), (admin) => swapInRestoredDatabase(admin, { database: live.name, restored: restored.name, previous, force: false }));
    expect(terminated).toBe(0);
    expect(await marker(live.ownerUrl)).toBe('restored');
    const prevUrl = live.ownerUrl.replace(`/${live.name}`, `/${previous}`);
    expect(await marker(prevUrl)).toBe('original');
    expect(await databaseExists(restored.name)).toBe(false);
    expect(await allowConn(live.name)).toBe(true);
    expect(await allowConn(previous)).toBe(true);
  });

  it('when the second rename fails, renames the original back and re-enables connections', async () => {
    const { live, restored, previous } = await pair('sw_fail');
    // A session on the restored database makes "RENAME restored TO live" fail (database is being accessed).
    const holder = new pg.Client({ connectionString: restored.ownerUrl, application_name: 'test-holder' });
    await holder.connect();
    try {
      const err = await withClient(maintenanceUrl(), (admin) => swapInRestoredDatabase(admin, { database: live.name, restored: restored.name, previous, force: false })).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/was renamed back and is unchanged/);
    } finally {
      await holder.end();
    }
    expect(await databaseExists(live.name)).toBe(true);
    expect(await databaseExists(previous)).toBe(false);
    expect(await databaseExists(restored.name)).toBe(true);
    expect(await allowConn(live.name)).toBe(true);
    expect(await marker(live.ownerUrl)).toBe('original');
  });

  it('refuses when a session is connected to the live database, unless forced (then ends it)', async () => {
    const { live, restored, previous } = await pair('sw_sess');
    const s = new pg.Client({ connectionString: live.ownerUrl, application_name: 'someone' });
    await s.connect();
    s.on('error', () => undefined); // it is terminated below
    const refused = await withClient(maintenanceUrl(), (admin) => swapInRestoredDatabase(admin, { database: live.name, restored: restored.name, previous, force: false })).catch((e) => e);
    expect(refused).toBeInstanceOf(OpsRefused);
    expect(await allowConn(live.name)).toBe(true);
    expect(await marker(live.ownerUrl)).toBe('original');

    const terminated = await withClient(maintenanceUrl(), (admin) => swapInRestoredDatabase(admin, { database: live.name, restored: restored.name, previous, force: true }));
    expect(terminated).toBe(1);
    expect(await marker(live.ownerUrl)).toBe('restored');
    await s.end().catch(() => undefined);
  });
});

describe('pg_dump / pg_restore (needs the PostgreSQL client tools)', () => {
  const needsTools = () => {
    if (!tools) {
      console.warn(`[backup-restore.test] skipped: ${toolsMissing.slice(0, 120)}…`);
      return false;
    }
    return true;
  };

  it('backs up a migrated database to a verified custom-format archive', async (ctx) => {
    if (!needsTools()) return ctx.skip();
    const d = await scratch('bk_ok');
    const out = path.join(scratchDir, 'out-ok');
    const r = await backupDatabase({ databaseUrl: d.ownerUrl, outDir: out, now: new Date('2026-11-22T10:11:12Z') });
    expect(path.basename(r.file)).toBe(`${d.name}-20261122-101112Z.dump`);
    expect(r.bytes).toBeGreaterThan(1000);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.serverMajor).toBe(serverMajor);
  });

  it('refuses a file that is not a pg_dump archive', async (ctx) => {
    if (!needsTools()) return ctx.skip();
    const d = await scratch('rs_bad');
    const file = path.join(scratchDir, 'garbage.dump');
    await writeFile(file, 'PGDMP? no, just text');
    await expect(restoreDatabase({ databaseUrl: d.ownerUrl, file, confirm: d.name })).rejects.toThrow(/not a readable pg_dump custom-format archive/);
  });

  it('refuses an archive without schema_migrations (not a Nigafiy database)', async (ctx) => {
    if (!needsTools()) return ctx.skip();
    const other = await scratch('bk_other', { migrate: false });
    await withClient(other.ownerUrl, (c) => c.query('CREATE TABLE unrelated (x int)'));
    const { file } = await backupDatabase({ databaseUrl: other.ownerUrl, outDir: path.join(scratchDir, 'out-other') });
    const d = await scratch('rs_other');
    await expect(restoreDatabase({ databaseUrl: d.ownerUrl, file, confirm: d.name })).rejects.toThrow(/does not contain a schema_migrations table/);
  });

  it('restores end to end: new database, swap, previous kept, migrations, audit', async (ctx) => {
    if (!needsTools()) return ctx.skip();
    const d = await scratch('rs_e2e');
    await withClient(d.ownerUrl, (c) => c.query(`INSERT INTO organizations (name) VALUES ('restore corp')`));
    const { file, sha256 } = await backupDatabase({ databaseUrl: d.ownerUrl, outDir: path.join(scratchDir, 'out-e2e') });
    await withClient(d.ownerUrl, (c) => c.query(`UPDATE organizations SET name = 'changed after backup'`));

    const r = await restoreDatabase({ databaseUrl: d.ownerUrl, appDatabaseUrl: d.appUrl, file, confirm: d.name, now: new Date('2026-11-22T10:00:00Z'), operator: { osUser: 'tester', host: 'h' } });
    expect(r.sha256).toBe(sha256);
    expect(r.auditRows).toBe(1);
    expect(await databaseExists(r.previousDatabase)).toBe(true);
    const names = await withClient(d.ownerUrl, async (c) => (await c.query<{ name: string }>('SELECT name FROM organizations')).rows.map((x) => x.name));
    expect(names).toEqual(['restore corp']);
    const audit = await withClient(d.ownerUrl, async (c) => (await c.query(`SELECT actor, metadata FROM audit_logs WHERE action = 'database.restored'`)).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe('system');
    expect(audit[0].metadata).toMatchObject({ tool: 'db-restore', sha256, previous_database: r.previousDatabase, operator_os_user: 'tester' });
    // The restored copy carries the full schema history.
    const migrations = await withClient(d.ownerUrl, async (c) => (await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n);
    expect(migrations).toBeGreaterThan(20);
  });

  it('a failing pg_restore leaves the live database untouched and drops the half-restored one', async (ctx) => {
    if (!needsTools()) return ctx.skip();
    const role = `ld_tmp_grant_${Date.now()}`;
    const src = await scratch('bk_grant');
    await withClient(src.ownerUrl, (c) => c.query(`CREATE ROLE ${role}; GRANT SELECT ON organizations TO ${role}`));
    const { file } = await backupDatabase({ databaseUrl: src.ownerUrl, outDir: path.join(scratchDir, 'out-grant') });
    await dropDatabase(src.name);
    await adminQuery(`DROP ROLE ${role}`); // the archive's GRANT now fails → pg_restore exits with an error

    const d = await scratch('rs_fail');
    await withClient(d.ownerUrl, (c) => c.query(`INSERT INTO organizations (name) VALUES ('untouched')`));
    await expect(restoreDatabase({ databaseUrl: d.ownerUrl, file, confirm: d.name })).rejects.toThrow(/pg_restore failed .* was not changed/s);
    const names = await withClient(d.ownerUrl, async (c) => (await c.query<{ name: string }>('SELECT name FROM organizations')).rows.map((x) => x.name));
    expect(names).toEqual(['untouched']);
    expect(await databasesLike(`${d.name}_`)).toEqual([]);
    expect(await allowConn(d.name)).toBe(true);
  });
});
