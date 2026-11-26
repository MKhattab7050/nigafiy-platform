import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import pg from 'pg';
import { keyId } from '../common/secret-box.ts';
import { migrate } from '../database/migrate.ts';
import { databaseName, OpsRefused, swapInRestoredDatabase } from './backup.ts';
import { auditOperation } from './db-activity.ts';
import { rotateEncryptionKey } from './rotate-key.ts';

/**
 * Backups without PostgreSQL client tools (UX review 2026-11-26, item 15).
 *
 * The embedded PostgreSQL of an installed copy ships no pg_dump / pg_restore, so "Back up now" and the
 * scheduled backups export through the API's own owner connection instead: one consistent snapshot
 * (REPEATABLE READ, read only) written as gzip-compressed JSON lines.
 *
 *   line 1      header: format, version, when, app version, the applied migrations, the fingerprint
 *               of the encryption key the sealed columns use, and (optional) that key sealed with
 *               the owner's passphrase
 *   then        per table: { t: 'table', name, columns } followed by { t: 'rows', rows: [...] } batches
 *               (each row is row_to_json of the stored columns; generated columns are left out)
 *               per sequence: { t: 'seq', name, last_value }
 *   last line   { t: 'end', tables, rows }: a file without it is incomplete and is refused
 *
 * The file is written as `*.partial`, read back to the end line, and only then renamed.
 *
 * Restore never touches the live database until the end: a new database is migrated to exactly the
 * backup's migrations, the rows are loaded (triggers and foreign-key checks off while loading, one
 * transaction), newer migrations run, the sealed columns are re-encrypted to this installation's key
 * when the backup used another one, and only then is it swapped in by renaming (the previous database
 * is kept as `<name>_before_restore_<time>`).
 */

export const BACKUP_EXT = '.nigafiy-backup';
const FORMAT = 'nigafiy-backup';
const VERSION = 1;
const FETCH = 1000;
const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'database', 'migrations');

// ── the key envelope ─────────────────────────────────────────────────────────

export interface KeyEnvelope {
  v: 1;
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
  /** keyId() of the key inside. */
  key_id: string;
}

const SCRYPT = { n: 2 ** 15, r: 8, p: 1 };
export const MIN_PASSPHRASE = 10;

function derive(passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(passphrase.normalize('NFC'), salt, 32, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
}

/** Seals the 32-byte encryption key with a passphrase (scrypt + AES-256-GCM). The passphrase is not kept. */
export function sealKeyEnvelope(key: Buffer, passphrase: string): KeyEnvelope {
  if (passphrase.length < MIN_PASSPHRASE) throw new OpsRefused(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(passphrase, salt, SCRYPT.n, SCRYPT.r, SCRYPT.p), iv);
  cipher.setAAD(Buffer.from(FORMAT));
  const ct = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    v: 1,
    kdf: 'scrypt',
    ...SCRYPT,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    key_id: keyId(key),
  };
}

export class WrongPassphrase extends OpsRefused {
  constructor() {
    super('The passphrase is not the one this backup was protected with.');
    this.name = 'WrongPassphrase';
  }
}

/** Opens an envelope; throws WrongPassphrase when the passphrase does not fit. */
export function openKeyEnvelope(envelope: KeyEnvelope, passphrase: string): Buffer {
  if (envelope?.v !== 1 || envelope.kdf !== 'scrypt') throw new OpsRefused('The key in this backup is stored in a form this version does not know.');
  // Bounded work factors: a crafted file must not make the server spend minutes or gigabytes.
  if (envelope.n > 2 ** 17 || envelope.r > 16 || envelope.p > 4) throw new OpsRefused('The key in this backup asks for unreasonable work factors.');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      derive(passphrase, Buffer.from(envelope.salt, 'base64'), envelope.n, envelope.r, envelope.p),
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(FORMAT));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const key = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
    if (key.length !== 32 || !timingSafeEqual(Buffer.from(keyId(key)), Buffer.from(envelope.key_id))) throw new Error('mismatch');
    return key;
  } catch {
    throw new WrongPassphrase();
  }
}

// ── file format ──────────────────────────────────────────────────────────────

export interface BackupHeader {
  format: typeof FORMAT;
  version: number;
  created_at: string;
  app_version: string;
  database: string;
  kind: 'manual' | 'auto';
  migrations: string[];
  /** keyId() of the APP_ENCRYPTION_KEY the sealed columns were sealed with. */
  key_id: string;
  /** That key, sealed with the owner's passphrase; null when no passphrase was set. */
  key_envelope: KeyEnvelope | null;
}

type Line =
  | { t: 'table'; name: string; columns: string[] }
  | { t: 'rows'; rows: Record<string, unknown>[] }
  | { t: 'seq'; name: string; last_value: string | null }
  | { t: 'end'; tables: number; rows: number };

function stampUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const FILE_NAME = /^nigafiy-(\d{8}-\d{6}Z)(?:-\d+)?-(manual|auto)\.nigafiy-backup$/;
export const parseBackupName = (name: string): { kind: 'manual' | 'auto' } | null => {
  const m = FILE_NAME.exec(name);
  return m ? { kind: m[2] as 'manual' | 'auto' } : null;
};

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Reads the lines of a backup file in order. */
async function* readLines(file: string): AsyncGenerator<unknown> {
  const input = createReadStream(file);
  const gunzip = createGunzip();
  const rl = createInterface({ input: input.pipe(gunzip), crlfDelay: Number.POSITIVE_INFINITY });
  input.on('error', (err) => gunzip.destroy(err));
  try {
    for await (const line of rl) if (line) yield JSON.parse(line);
  } finally {
    rl.close();
    input.destroy();
  }
}

function checkHeader(h: unknown): BackupHeader {
  const x = h as Partial<BackupHeader> | null;
  if (!x || x.format !== FORMAT) throw new OpsRefused('This file is not a Nigafiy backup.');
  if (x.version !== VERSION) throw new OpsRefused(`This backup has format version ${x.version}; this version of Nigafiy reads version ${VERSION}.`);
  if (!Array.isArray(x.migrations) || typeof x.key_id !== 'string') throw new OpsRefused('The backup header is damaged.');
  return x as BackupHeader;
}

/** The header of a backup file (first line only). */
export async function readBackupHeader(file: string): Promise<BackupHeader> {
  try {
    for await (const line of readLines(file)) return checkHeader(line);
  } catch (err) {
    if (err instanceof OpsRefused) throw err;
    throw new OpsRefused(`This file is not a readable Nigafiy backup (${(err as Error).message}).`);
  }
  throw new OpsRefused('The backup file is empty.');
}

/** Reads the whole file: it must end with the end line and the counts must match. */
export async function verifyBackupFile(file: string): Promise<{ header: BackupHeader; tables: number; rows: number }> {
  let header: BackupHeader | null = null;
  let tables = 0;
  let rows = 0;
  try {
    for await (const raw of readLines(file)) {
      if (!header) {
        header = checkHeader(raw);
        continue;
      }
      const line = raw as Line;
      if (line.t === 'table') tables++;
      else if (line.t === 'rows') rows += line.rows.length;
      else if (line.t === 'end') {
        if (line.tables !== tables || line.rows !== rows) throw new OpsRefused('The backup is damaged: its counts do not match.');
        return { header, tables, rows };
      }
    }
  } catch (err) {
    if (err instanceof OpsRefused) throw err;
    throw new OpsRefused(`The backup file is damaged (${(err as Error).message}).`);
  }
  throw new OpsRefused('The backup file is incomplete (it has no end).');
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// ── export ───────────────────────────────────────────────────────────────────

export interface ExportOptions {
  databaseUrl: string;
  outDir: string;
  kind: 'manual' | 'auto';
  /** The key the sealed columns use today (only its fingerprint is written, plus the envelope). */
  currentKey: Buffer;
  keyEnvelope: KeyEnvelope | null;
  appVersion: string;
  now?: Date;
}

export interface ExportResult {
  file: string;
  bytes: number;
  sha256: string;
  tables: number;
  rows: number;
  keyIncluded: boolean;
}

export async function exportDatabase(opts: ExportOptions): Promise<ExportResult> {
  const currentId = keyId(opts.currentKey);
  // An envelope made before a key rotation holds the old key: it would restore nothing. Leave it out.
  const envelope = opts.keyEnvelope && opts.keyEnvelope.key_id === currentId ? opts.keyEnvelope : null;
  const outDir = path.resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });
  const stamp = stampUtc(opts.now ?? new Date());
  let file = path.join(outDir, `nigafiy-${stamp}-${opts.kind}${BACKUP_EXT}`);
  for (let n = 2; existsSync(file); n++) file = path.join(outDir, `nigafiy-${stamp}-${n}-${opts.kind}${BACKUP_EXT}`);
  const partial = `${file}.partial`;

  const client = new pg.Client({ connectionString: opts.databaseUrl, application_name: 'nigafiy-backup' });
  await client.connect();
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(partial, { mode: 0o600 });
  gzip.pipe(out);
  const write = async (obj: unknown) => {
    if (!gzip.write(`${JSON.stringify(obj)}\n`)) await once(gzip, 'drain');
  };
  let tables = 0;
  let rows = 0;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migrations = (await client.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    const header: BackupHeader = {
      format: FORMAT,
      version: VERSION,
      created_at: (opts.now ?? new Date()).toISOString(),
      app_version: opts.appVersion,
      database: databaseName(opts.databaseUrl),
      kind: opts.kind,
      migrations,
      key_id: currentId,
      key_envelope: envelope,
    };
    await write(header);
    const tableNames = (
      await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
      )
    ).rows.map((r) => r.relname);
    for (const name of tableNames) {
      const columns = (
        await client.query<{ attname: string }>(
          `SELECT attname FROM pg_attribute
            WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
          [`public.${ident(name)}`],
        )
      ).rows.map((r) => r.attname);
      await write({ t: 'table', name, columns } satisfies Line);
      tables++;
      if (!columns.length) continue;
      await client.query(
        `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT row_to_json(x)::text AS j FROM (SELECT ${columns.map(ident).join(', ')} FROM ONLY public.${ident(name)}) x`,
      );
      for (;;) {
        const batch = await client.query<{ j: string }>(`FETCH ${FETCH} FROM backup_rows`);
        if (!batch.rows.length) break;
        // The rows are already JSON text: splice them in instead of parsing and re-serialising.
        const line = `{"t":"rows","rows":[${batch.rows.map((r) => r.j).join(',')}]}\n`;
        if (!gzip.write(line)) await once(gzip, 'drain');
        rows += batch.rows.length;
      }
      await client.query('CLOSE backup_rows');
    }
    const seqs = await client.query<{ sequencename: string; last_value: string | null }>(
      `SELECT sequencename, last_value::text FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`,
    );
    for (const s of seqs.rows) await write({ t: 'seq', name: s.sequencename, last_value: s.last_value } satisfies Line);
    await write({ t: 'end', tables, rows } satisfies Line);
    await client.query('COMMIT');
    gzip.end();
    await finished(out);
  } catch (err) {
    gzip.destroy();
    out.destroy();
    await rm(partial, { force: true });
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
  try {
    await verifyBackupFile(partial);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, file);
  return { file, bytes: (await stat(file)).size, sha256: await sha256File(file), tables, rows, keyIncluded: envelope !== null };
}

// ── restore ──────────────────────────────────────────────────────────────────

export interface LogicalRestoreOptions {
  databaseUrl: string;
  appDatabaseUrl: string;
  file: string;
  /** The key this installation runs with (APP_ENCRYPTION_KEY). */
  currentKey: Buffer;
  /** Opens the key in the backup when it was made with another key. */
  passphrase?: string;
  /** Restore although stored secrets (router, SMTP… passwords) cannot be read afterwards. */
  allowUnreadableSecrets?: boolean;
  maintenanceDb?: string;
  operator?: Record<string, string>;
  log?: (line: string) => void;
  now?: Date;
}

export interface LogicalRestoreResult {
  database: string;
  previousDatabase: string;
  tables: number;
  rows: number;
  migrationsApplied: string[];
  /** The sealed columns were re-encrypted from the backup's key to this installation's key. */
  keyRotated: boolean;
  /** False when the backup used another key and it could not be opened (allowUnreadableSecrets). */
  secretsReadable: boolean;
  backupCreatedAt: string;
}

export type RestoreRefusal = 'passphrase_needed' | 'key_missing';

export class RestoreNeedsKey extends OpsRefused {
  readonly reason: RestoreRefusal;
  constructor(reason: RestoreRefusal) {
    super(
      reason === 'passphrase_needed'
        ? 'This backup was made with another encryption key. Enter the backup passphrase to read its stored passwords.'
        : 'This backup was made with another encryption key and does not contain it, so stored router, SMTP and other passwords could not be read after the restore.',
    );
    this.name = 'RestoreNeedsKey';
    this.reason = reason;
  }
}

function withDatabase(databaseUrl: string, name: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

function sideName(base: string, suffix: string): string {
  const room = 63 - Buffer.byteLength(suffix);
  let b = base;
  while (Buffer.byteLength(b) > room) b = b.slice(0, -1);
  return b + suffix;
}

/** What a restore of `file` needs, without changing anything (for the Settings page). */
export async function inspectBackup(file: string, currentKey: Buffer): Promise<{ header: BackupHeader; sameKey: boolean; needsPassphrase: boolean; keyMissing: boolean; newerVersion: boolean }> {
  const header = await readBackupHeader(file);
  const sameKey = header.key_id === keyId(currentKey);
  const known = await migrationFiles();
  return {
    header,
    sameKey,
    needsPassphrase: !sameKey && header.key_envelope !== null,
    keyMissing: !sameKey && header.key_envelope === null,
    newerVersion: !header.migrations.every((m, i) => known[i] === m),
  };
}

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

export async function restoreLogicalBackup(opts: LogicalRestoreOptions): Promise<LogicalRestoreResult> {
  const log = opts.log ?? (() => undefined);
  const file = path.resolve(opts.file);
  if (!existsSync(file)) throw new OpsRefused(`Backup file not found: ${file}`);
  const { header, tables: fileTables, rows: fileRows } = await verifyBackupFile(file);

  // 1. Which key the backup's secrets need.
  let backupKey: Buffer | null = null;
  let secretsReadable = true;
  if (header.key_id !== keyId(opts.currentKey)) {
    if (header.key_envelope) {
      if (!opts.passphrase) throw new RestoreNeedsKey('passphrase_needed');
      backupKey = openKeyEnvelope(header.key_envelope, opts.passphrase);
    } else if (opts.allowUnreadableSecrets) {
      secretsReadable = false;
    } else {
      throw new RestoreNeedsKey('key_missing');
    }
  }

  // 2. The backup's migrations must be the first ones of this version (a newer backup cannot be read).
  const known = await migrationFiles();
  if (!header.migrations.every((m, i) => known[i] === m)) {
    throw new OpsRefused(`This backup was made by a newer version of Nigafiy (${header.app_version}). Update this installation first, then restore.`);
  }
  const stopBefore = known[header.migrations.length];

  const database = databaseName(opts.databaseUrl);
  const admin = new pg.Client({ connectionString: withDatabase(opts.databaseUrl, opts.maintenanceDb ?? 'postgres'), application_name: 'nigafiy-restore' });
  await admin.connect();
  const stamp = stampUtc(opts.now ?? new Date())
    .replace(/[-Z]/g, '')
    .toLowerCase();
  const temp = sideName(database, `_restoring_${stamp}`);
  const previous = sideName(database, `_before_restore_${stamp}`);
  const tempUrl = withDatabase(opts.databaseUrl, temp);
  let tempCreated = false;
  try {
    const info = await admin.query<{ encoding: string }>('SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1', [database]);
    if (!info.rows[0]) throw new OpsRefused(`Database "${database}" does not exist on this server.`);
    await admin.query(`CREATE DATABASE ${ident(temp)} TEMPLATE template0 ENCODING ${admin.escapeLiteral(info.rows[0].encoding)}`);
    tempCreated = true;

    // 3. The schema exactly as the backup knew it.
    log(`Preparing a new database "${temp}" …`);
    await migrate(tempUrl, opts.appDatabaseUrl, () => undefined, stopBefore ? { stopBefore } : {});

    // 4. The rows.
    log('Loading the rows …');
    const loaded = await loadRows(tempUrl, file);
    if (loaded.rows !== fileRows || loaded.tables !== fileTables) throw new Error('the number of restored rows does not match the backup');

    // 5. Newer migrations, then this installation's key.
    const migrationsApplied: string[] = [];
    await migrate(tempUrl, opts.appDatabaseUrl, (m) => {
      if (m.startsWith('applied ')) migrationsApplied.push(m.slice('applied '.length));
    });
    let keyRotated = false;
    if (backupKey && !backupKey.equals(opts.currentKey)) {
      log('Re-encrypting stored passwords with this installation’s key …');
      await rotateEncryptionKey({ databaseUrl: tempUrl, oldKey: backupKey, newKey: opts.currentKey, force: true });
      keyRotated = true;
    }

    // 6. Swap it in (the running API's sessions are ended; its pools reconnect to the restored database).
    await swapInRestoredDatabase(admin, { database, restored: temp, previous, force: true });
    tempCreated = false;
    log(`Swapped in the restored database; the previous one is kept as "${previous}".`);

    const client = new pg.Client({ connectionString: opts.databaseUrl, application_name: 'nigafiy-restore' });
    await client.connect();
    try {
      await client.query('BEGIN');
      await auditOperation(client, 'database.restored', { type: 'installation' }, () => ({
        tool: 'app-restore',
        file: path.basename(file),
        backup_created_at: header.created_at,
        previous_database: previous,
        key_rotated: keyRotated,
        secrets_readable: secretsReadable,
        migrations_applied: migrationsApplied.length,
        ...(opts.operator ?? {}),
      }));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client.end().catch(() => undefined);
    }
    return {
      database,
      previousDatabase: previous,
      tables: loaded.tables,
      rows: loaded.rows,
      migrationsApplied,
      keyRotated,
      secretsReadable,
      backupCreatedAt: header.created_at,
    };
  } finally {
    if (tempCreated) await admin.query(`DROP DATABASE IF EXISTS ${ident(temp)} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

/** Loads every row of `file` into the (freshly migrated) database at `url`, in one transaction. */
async function loadRows(url: string, file: string): Promise<{ tables: number; rows: number }> {
  const client = new pg.Client({ connectionString: url, application_name: 'nigafiy-restore' });
  await client.connect();
  let tables = 0;
  let rows = 0;
  try {
    await client.query('BEGIN');
    try {
      // Triggers (including foreign-key checks) stay quiet while rows arrive in table-name order.
      await client.query('SET LOCAL session_replication_role = replica');
    } catch (err) {
      throw new OpsRefused(`The database account cannot load a backup (${(err as Error).message}).`);
    }
    const existing = (
      await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
      )
    ).rows.map((r) => r.relname);
    // Rows that migrations seeded are replaced by the backup's own.
    if (existing.length) await client.query(`TRUNCATE ${existing.map((t) => `public.${ident(t)}`).join(', ')}`);
    const existingSet = new Set(existing);

    let current: { name: string; insert: string | null } | null = null;
    let first = true;
    for await (const raw of readLines(file)) {
      if (first) {
        first = false;
        continue;
      }
      const line = raw as Line;
      if (line.t === 'table') {
        tables++;
        if (line.name === 'schema_migrations' || !existingSet.has(line.name)) {
          current = { name: line.name, insert: null };
          continue;
        }
        const cols = new Set(
          (
            await client.query<{ attname: string }>(
              `SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`,
              [`public.${ident(line.name)}`],
            )
          ).rows.map((r) => r.attname),
        );
        const common = line.columns.filter((c) => cols.has(c)).map(ident).join(', ');
        const table = `public.${ident(line.name)}`;
        current = {
          name: line.name,
          insert: common ? `INSERT INTO ${table} (${common}) OVERRIDING SYSTEM VALUE SELECT ${common} FROM json_populate_recordset(NULL::${table}, $1::json)` : null,
        };
      } else if (line.t === 'rows') {
        rows += line.rows.length;
        if (current?.insert) await client.query(current.insert, [JSON.stringify(line.rows)]);
      } else if (line.t === 'seq') {
        if (line.last_value === null) continue;
        const exists = await client.query(`SELECT 1 FROM pg_sequences WHERE schemaname = 'public' AND sequencename = $1`, [line.name]);
        if (exists.rowCount) await client.query('SELECT setval($1::regclass, $2::bigint, true)', [`public.${ident(line.name)}`, line.last_value]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
  return { tables, rows };
}

// ── the folder ───────────────────────────────────────────────────────────────

export interface BackupFileInfo {
  name: string;
  kind: 'manual' | 'auto';
  bytes: number;
  modified_at: string;
}

/** Backups in a folder, newest first (only files named like ours). */
export async function listBackups(dir: string): Promise<BackupFileInfo[]> {
  if (!existsSync(dir)) return [];
  const out: BackupFileInfo[] = [];
  for (const name of await readdir(dir)) {
    const parsed = parseBackupName(name);
    if (!parsed) continue;
    const s = await stat(path.join(dir, name)).catch(() => null);
    if (!s?.isFile()) continue;
    out.push({ name, kind: parsed.kind, bytes: s.size, modified_at: s.mtime.toISOString() });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** Keeps the newest `keep` scheduled backups; "Back up now" files are never removed. Returns the removed names. */
export async function pruneAutoBackups(dir: string, keep: number): Promise<string[]> {
  const autos = (await listBackups(dir)).filter((b) => b.kind === 'auto');
  const removed: string[] = [];
  for (const b of autos.slice(keep)) {
    await rm(path.join(dir, b.name), { force: true });
    removed.push(b.name);
  }
  return removed;
}
