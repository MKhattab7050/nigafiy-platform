import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readEnv } from '../config/env-compat.ts';
import { ensureAppRole, migrate } from '../database/migrate.ts';
import { auditOperation, describeSessions, otherSessions, terminateSessions } from './db-activity.ts';

/**
 * Database backup and restore with PostgreSQL's own tools (`pg_dump` / `pg_restore`), for both the
 * embedded server (scripts/local.mjs, the Nigafiy engine stack) and an external PostgreSQL.
 * Procedure: docs/operations/backup-restore-and-key-rotation.md.
 *
 * Restore never overwrites the live database in place: the archive is restored into a new database,
 * checked, and then swapped in by renaming (one transaction). The previous database is kept under a
 * `<name>_before_restore_<time>` name until the operator drops it.
 */

const EXE = process.platform === 'win32' ? '.exe' : '';
export type PgTool = 'pg_dump' | 'pg_restore';

export class OpsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsRefused';
  }
}

// ── locating pg_dump / pg_restore ────────────────────────────────────────────

function embeddedPlatformPackage(): string | null {
  const arch = process.arch;
  if (process.platform === 'win32' && arch === 'x64') return '@embedded-postgres/windows-x64';
  if (process.platform === 'darwin') return arch === 'arm64' ? '@embedded-postgres/darwin-arm64' : '@embedded-postgres/darwin-x64';
  if (process.platform === 'linux') return `@embedded-postgres/linux-${arch === 'x64' ? 'x64' : arch}`;
  return null;
}

/** The `bin` folder of the embedded-postgres binaries this API runs its local database with. */
export function embeddedBinDir(): string | null {
  const pkg = embeddedPlatformPackage();
  if (!pkg) return null;
  try {
    const embeddedEntry = fileURLToPath(import.meta.resolve('embedded-postgres'));
    const entry = createRequire(embeddedEntry).resolve(pkg);
    return path.resolve(path.dirname(entry), '..', 'native', 'bin');
  } catch {
    return null;
  }
}

function versionedDirs(parent: string, pattern: RegExp, suffix: string[]): string[] {
  if (!existsSync(parent)) return [];
  try {
    return readdirSync(parent)
      .map((name) => ({ name, m: pattern.exec(name) }))
      .filter((e) => e.m)
      .sort((a, b) => Number(b.m![1]) - Number(a.m![1]))
      .map((e) => path.join(parent, e.name, ...suffix));
  } catch {
    return [];
  }
}

/** Where the tools are looked for, in order. An explicit folder (flag or env) is the only candidate. */
export function candidateBinDirs(explicit?: string): { dirs: string[]; explicit: boolean } {
  const fromEnv = readEnv('NIGAFIY_PG_BIN_DIR');
  if (explicit || fromEnv) return { dirs: [path.resolve((explicit || fromEnv)!)], explicit: true };
  const dirs: string[] = [];
  const embedded = embeddedBinDir();
  if (embedded) dirs.push(embedded);
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) if (d) dirs.push(d);
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) dirs.push(...versionedDirs(path.join(base, 'PostgreSQL'), /^(\d+)/, ['bin']));
    }
  } else if (process.platform === 'darwin') {
    dirs.push(...versionedDirs('/opt/homebrew/opt', /^postgresql@(\d+)$/, ['bin']));
    dirs.push(...versionedDirs('/usr/local/opt', /^postgresql@(\d+)$/, ['bin']));
    dirs.push(...versionedDirs('/Applications/Postgres.app/Contents/Versions', /^(\d+)/, ['bin']));
  } else {
    dirs.push(...versionedDirs('/usr/lib/postgresql', /^(\d+)$/, ['bin']));
    dirs.push(...versionedDirs('/usr', /^pgsql-(\d+)$/, ['bin']));
  }
  return { dirs: [...new Set(dirs)], explicit: false };
}

/** Major version printed by `<tool> --version` ("pg_dump (PostgreSQL) 18.1"), or null. */
export function toolMajor(exe: string): number | null {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (r.status !== 0) return null;
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(r.stdout);
  return m ? Number(m[1]) : null;
}

export interface ResolvedTool {
  path: string;
  major: number;
}

/**
 * Finds `tool` with a major version ≥ the server's (pg_dump refuses older; pg_restore must read the
 * archive). Throws OpsRefused with what was checked and how to fix it.
 */
export function resolveTool(tool: PgTool, serverMajor: number, explicitDir?: string): ResolvedTool {
  const { dirs, explicit } = candidateBinDirs(explicitDir);
  const tooOld: string[] = [];
  for (const dir of dirs) {
    const exe = path.join(dir, tool + EXE);
    if (!existsSync(exe)) continue;
    const major = toolMajor(exe);
    if (major === null) continue;
    if (major >= serverMajor) return { path: exe, major };
    tooOld.push(`${exe} (version ${major})`);
  }
  const where = explicit ? `in ${dirs[0]}` : 'next to the embedded PostgreSQL, on PATH or in the usual install folders';
  const old = tooOld.length ? ` Found only older versions: ${tooOld.join(', ')}.` : '';
  throw new OpsRefused(
    `${tool} ${serverMajor} or newer was not found ${where}.${old} The embedded PostgreSQL package ships only the server (initdb, pg_ctl, postgres), not the client tools. ` +
      `Install the PostgreSQL ${serverMajor} client tools (Windows: the EDB installer with only "Command Line Tools" selected; Debian/Ubuntu: postgresql-client-${serverMajor} from apt.postgresql.org; macOS: brew install postgresql@${serverMajor}) ` +
      'and/or point NIGAFIY_PG_BIN_DIR (or --pg-bin) at the folder holding pg_dump and pg_restore.',
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** libpq target without the password (it goes in PGPASSWORD, never on a command line). */
export function libpqTarget(databaseUrl: string): { dbname: string; env: Record<string, string> } {
  const u = new URL(databaseUrl);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { dbname: u.toString(), env: password ? { PGPASSWORD: password } : {} };
}

export function databaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!name) throw new OpsRefused('The database URL names no database.');
  return name;
}

function withDatabase(databaseUrl: string, name: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

function stampUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** The data folder: NIGAFIY_DATA_DIR (legacy LD_DATA_DIR; what scripts/local.mjs and the engine set), else <repo>/.data. */
export function dataDir(): string {
  const fromEnv = readEnv('NIGAFIY_DATA_DIR');
  return fromEnv ? path.resolve(fromEnv) : path.resolve(import.meta.dirname, '../../../../.data');
}

export const defaultBackupDir = (): string => path.join(dataDir(), 'backups');

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function run(exe: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 64_000) stderr += d.toString('utf8');
    });
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 4_000_000) stdout += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr: stderr.trim(), stdout }));
  });
}

async function serverMajor(client: pg.Client): Promise<number> {
  const r = await client.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  return Math.floor(Number(r.rows[0]!.v) / 10_000);
}

/** `pg_restore --list` succeeds: the file is a readable custom-format archive. Returns its table of contents. */
async function archiveToc(pgRestore: string, file: string): Promise<string> {
  const r = await run(pgRestore, ['--list', file], {});
  if (r.code !== 0) throw new OpsRefused(`${file} is not a readable pg_dump custom-format archive: ${r.stderr || `exit code ${r.code}`}`);
  return r.stdout;
}

// ── backup ───────────────────────────────────────────────────────────────────

export interface BackupOptions {
  databaseUrl: string;
  outDir?: string;
  binDir?: string;
  log?: (line: string) => void;
  now?: Date;
}

export interface BackupResult {
  file: string;
  bytes: number;
  sha256: string;
  database: string;
  serverMajor: number;
  pgDump: ResolvedTool;
}

/** Writes `<outDir>/<database>-<YYYYMMDD-HHMMSS>Z.dump` (pg_dump custom format) and checks it reads back. */
export async function backupDatabase(opts: BackupOptions): Promise<BackupResult> {
  const log = opts.log ?? (() => undefined);
  const database = databaseName(opts.databaseUrl);
  const client = new pg.Client({ connectionString: opts.databaseUrl, application_name: 'nigafiy-backup' });
  await client.connect();
  let major: number;
  try {
    major = await serverMajor(client);
  } finally {
    await client.end().catch(() => undefined);
  }
  const pgDump = resolveTool('pg_dump', major, opts.binDir);
  const pgRestore = resolveTool('pg_restore', major, path.dirname(pgDump.path));
  log(`Using ${pgDump.path} (version ${pgDump.major}) for PostgreSQL ${major}`);

  const outDir = path.resolve(opts.outDir ?? defaultBackupDir());
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const stamp = stampUtc(opts.now ?? new Date());
  let file = path.join(outDir, `${database}-${stamp}.dump`);
  for (let n = 2; existsSync(file); n++) file = path.join(outDir, `${database}-${stamp}-${n}.dump`);
  const partial = `${file}.partial`;

  const target = libpqTarget(opts.databaseUrl);
  const r = await run(pgDump.path, ['--format=custom', '--no-password', `--file=${partial}`, `--dbname=${target.dbname}`], { ...target.env, PGAPPNAME: 'nigafiy-backup' });
  if (r.code !== 0) {
    await rm(partial, { force: true });
    throw new Error(`pg_dump failed (exit code ${r.code}): ${r.stderr}`);
  }
  try {
    await archiveToc(pgRestore.path, partial);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, file);
  const bytes = (await stat(file)).size;
  return { file, bytes, sha256: await sha256File(file), database, serverMajor: major, pgDump };
}

// ── restore ──────────────────────────────────────────────────────────────────

export interface RestoreOptions {
  /** Owner connection to the database being replaced (DATABASE_URL). */
  databaseUrl: string;
  /** APP_DATABASE_URL: creates the lan_app role if missing, and runs migrations after the restore. */
  appDatabaseUrl?: string;
  file: string;
  /** Must equal the target database's name. */
  confirm: string | undefined;
  /** End other sessions (API instances included) instead of refusing. */
  force?: boolean;
  binDir?: string;
  /** Database to connect to for CREATE / RENAME DATABASE. Default "postgres". */
  maintenanceDb?: string;
  operator?: { osUser: string; host: string };
  log?: (line: string) => void;
  now?: Date;
}

export interface RestoreResult {
  database: string;
  previousDatabase: string;
  sha256: string;
  terminatedSessions: number;
  migrationsApplied: string[];
  auditRows: number;
}

function sideName(base: string, suffix: string): string {
  // PostgreSQL identifiers are at most 63 bytes.
  const room = 63 - Buffer.byteLength(suffix);
  let b = base;
  while (Buffer.byteLength(b) > room) b = b.slice(0, -1);
  return b + suffix;
}

/**
 * Puts `restored` in place of `database`, keeping the current one as `previous`. Returns how many
 * sessions were ended (only with `force`; otherwise a connected session refuses the swap).
 *
 * PostgreSQL does not allow ALTER DATABASE … RENAME inside a transaction block (SQLSTATE 25001), so
 * the two renames are separate statements. If the second one fails, the first is undone (`previous`
 * is renamed back to `database`) and connections are allowed again, so the server is left exactly as
 * it was. If even that undo fails, the error says which name the original database now has.
 */
export async function swapInRestoredDatabase(
  admin: pg.Client,
  names: { database: string; restored: string; previous: string; force: boolean },
): Promise<number> {
  const { database, restored, previous, force } = names;
  let terminated = 0;
  await admin.query(`ALTER DATABASE ${ident(database)} ALLOW_CONNECTIONS false`);
  try {
    for (let i = 0; i < 20; i++) {
      const left = await otherSessions(admin, database);
      if (!left.length) break;
      if (!force) throw new OpsRefused(`A session connected to "${database}" during the restore (${describeSessions(left)}). Nothing was changed; retry, or use --force.`);
      terminated += await terminateSessions(
        admin,
        left.map((s) => s.pid),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await admin.query(`ALTER DATABASE ${ident(database)} RENAME TO ${ident(previous)}`);
  } catch (err) {
    await admin.query(`ALTER DATABASE ${ident(database)} ALLOW_CONNECTIONS true`).catch(() => undefined);
    throw err;
  }
  try {
    await admin.query(`ALTER DATABASE ${ident(restored)} RENAME TO ${ident(database)}`);
  } catch (err) {
    const cause = (err as Error).message;
    try {
      await admin.query(`ALTER DATABASE ${ident(previous)} RENAME TO ${ident(database)}`);
    } catch (undoErr) {
      throw new Error(
        `Swapping in the restored database failed (${cause}) and renaming the original back failed too (${(undoErr as Error).message}). ` +
          `The original database is now named "${previous}" (connections disabled): rename it back with ALTER DATABASE "${previous}" RENAME TO "${database}"; ALTER DATABASE "${database}" ALLOW_CONNECTIONS true;`,
      );
    }
    await admin.query(`ALTER DATABASE ${ident(database)} ALLOW_CONNECTIONS true`).catch(() => undefined);
    throw new Error(`Swapping in the restored database failed; "${database}" was renamed back and is unchanged: ${cause}`);
  }
  await admin.query(`ALTER DATABASE ${ident(previous)} ALLOW_CONNECTIONS true`).catch(() => undefined);
  return terminated;
}

/**
 * Restores `file` as the database named in `databaseUrl`: restore into a new database (one
 * transaction, --exit-on-error), check it is a Nigafiy database, then swap the names in one
 * transaction. The previous database is kept. Refuses while other sessions are connected unless
 * `force` (they are then ended and new connections are blocked during the swap).
 */
export async function restoreDatabase(opts: RestoreOptions): Promise<RestoreResult> {
  const log = opts.log ?? (() => undefined);
  const database = databaseName(opts.databaseUrl);
  if (opts.confirm !== database) {
    throw new OpsRefused(`Restore replaces the database "${database}". Repeat its name to confirm: --confirm ${database}`);
  }
  const file = path.resolve(opts.file);
  if (!existsSync(file)) throw new OpsRefused(`Backup file not found: ${file}`);

  const maintUrl = withDatabase(opts.databaseUrl, opts.maintenanceDb ?? 'postgres');
  const admin = new pg.Client({ connectionString: maintUrl, application_name: 'nigafiy-restore' });
  await admin.connect();
  let tempCreated = false;
  const stamp = stampUtc(opts.now ?? new Date())
    .replace(/[-Z]/g, '')
    .toLowerCase();
  const temp = sideName(database, `_restoring_${stamp}`);
  const previous = sideName(database, `_before_restore_${stamp}`);
  try {
    const info = await admin.query<{ encoding: string; datcollate: string; datctype: string }>(
      'SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype FROM pg_database WHERE datname = $1',
      [database],
    );
    if (!info.rows[0]) throw new OpsRefused(`Database "${database}" does not exist on this server. Create it first (empty) or run the stack once.`);

    const sessions = await otherSessions(admin, database);
    if (sessions.length && !opts.force) {
      const api = sessions.some((s) => s.api);
      throw new OpsRefused(
        `${sessions.length} session(s) are connected to "${database}" (${describeSessions(sessions)}).` +
          (api ? ' The API is running: stop it (or the Nigafiy engine stack) first.' : '') +
          ' Use --force to end them. Nothing was changed.',
      );
    }

    const major = await serverMajor(admin);
    const pgRestore = resolveTool('pg_restore', major, opts.binDir);
    log(`Using ${pgRestore.path} (version ${pgRestore.major}) for PostgreSQL ${major}`);
    const toc = await archiveToc(pgRestore.path, file);
    if (!/\bTABLE\b.*\bschema_migrations\b/.test(toc)) throw new OpsRefused(`${file} does not contain a schema_migrations table: it is not a Nigafiy / Nigafiy database backup.`);
    const sha256 = await sha256File(file);

    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', ['lan_app']);
    if (!role.rowCount) {
      if (!opts.appDatabaseUrl) throw new OpsRefused('The role "lan_app" does not exist on this server and APP_DATABASE_URL is not set to create it.');
      await ensureAppRole(admin, opts.appDatabaseUrl);
      log('Created the lan_app role.');
    }

    // 1. Restore into a new, empty database.
    const db = info.rows[0];
    try {
      await admin.query(
        `CREATE DATABASE ${ident(temp)} TEMPLATE template0 ENCODING ${admin.escapeLiteral(db.encoding)} LC_COLLATE ${admin.escapeLiteral(db.datcollate)} LC_CTYPE ${admin.escapeLiteral(db.datctype)}`,
      );
    } catch {
      await admin.query(`CREATE DATABASE ${ident(temp)} TEMPLATE template0 ENCODING ${admin.escapeLiteral(db.encoding)}`);
    }
    tempCreated = true;
    log(`Restoring into the new database "${temp}" …`);
    const target = libpqTarget(withDatabase(opts.databaseUrl, temp));
    const r = await run(pgRestore.path, ['--no-owner', '--single-transaction', '--exit-on-error', '--no-password', `--dbname=${target.dbname}`, file], {
      ...target.env,
      PGAPPNAME: 'nigafiy-restore',
    });
    if (r.code !== 0) throw new Error(`pg_restore failed (exit code ${r.code}); "${database}" was not changed: ${r.stderr}`);

    const check = new pg.Client({ connectionString: withDatabase(opts.databaseUrl, temp), application_name: 'nigafiy-restore' });
    await check.connect();
    try {
      const ok = await check.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations')::text AS t`);
      if (!ok.rows[0]?.t) throw new OpsRefused('The restored database has no schema_migrations table; "' + database + '" was not changed.');
    } finally {
      await check.end().catch(() => undefined);
    }

    // 2. Swap: block new connections, end the remaining ones, rename (see swapInRestoredDatabase).
    const terminated = await swapInRestoredDatabase(admin, { database, restored: temp, previous, force: Boolean(opts.force) });
    tempCreated = false;
    log(`Swapped in the restored database; the previous one is kept as "${previous}".`);

    // 3. Bring the schema up to this version, then record the restore.
    const migrationsApplied: string[] = [];
    if (opts.appDatabaseUrl) await migrate(opts.databaseUrl, opts.appDatabaseUrl, (m) => migrationsApplied.push(m));
    const client = new pg.Client({ connectionString: opts.databaseUrl, application_name: 'nigafiy-restore' });
    await client.connect();
    let auditRows = 0;
    try {
      await client.query('BEGIN');
      auditRows = await auditOperation(client, 'database.restored', { type: 'installation' }, () => ({
        tool: 'db-restore',
        file: path.basename(file),
        sha256,
        previous_database: previous,
        terminated_sessions: terminated,
        migrations_applied: migrationsApplied.length,
        ...(opts.operator ? { operator_os_user: opts.operator.osUser, operator_host: opts.operator.host } : {}),
      }));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client.end().catch(() => undefined);
    }
    return { database, previousDatabase: previous, sha256, terminatedSessions: terminated, migrationsApplied, auditRows };
  } finally {
    if (tempCreated) await admin.query(`DROP DATABASE IF EXISTS ${ident(temp)} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
