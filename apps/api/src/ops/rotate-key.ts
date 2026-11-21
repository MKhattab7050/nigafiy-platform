import pg from 'pg';
import { keyId, openWithKey, sealWithKey } from '../common/secret-box.ts';
import { auditOperation, describeSessions, otherSessions } from './db-activity.ts';
import { SEALED_COLUMNS, SEALED_NAME_PATTERN, type SealedColumn } from './sealed-columns.ts';

export interface RotateOptions {
  /** Owner connection (DATABASE_URL). */
  databaseUrl: string;
  oldKey: Buffer;
  newKey: Buffer;
  /** Decrypt everything with the old key and report, but change nothing. */
  dryRun?: boolean;
  /** Rotate although API sessions are connected (they would keep sealing with the old key). */
  force?: boolean;
  /** Recorded in the audit entry. */
  operator?: { osUser: string; host: string };
  log?: (line: string) => void;
  /** Batch size for the UPDATEs (tests use small values). */
  batchSize?: number;
}

export interface ColumnCount {
  table: string;
  column: string;
  values: number;
}

export interface RotateResult {
  dryRun: boolean;
  columns: ColumnCount[];
  total: number;
  auditRows: number;
  oldKeyId: string;
  newKeyId: string;
}

/** The tool refused to rotate (nothing was changed). Messages never contain secret values. */
export class RotationRefused extends Error {
  readonly reason: 'same_key' | 'api_connected' | 'schema' | 'undecryptable';
  constructor(reason: RotationRefused['reason'], message: string) {
    super(message);
    this.name = 'RotationRefused';
    this.reason = reason;
  }
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

interface Row {
  key: string[];
  org: string | null;
  plain: string;
}

/** Locates a row for messages: table, column and primary key (never the value). */
const where = (c: SealedColumn, key: readonly string[]) => `${c.table}.${c.column} (${c.key.map((k, i) => `${k}=${key[i]}`).join(', ')})`;

async function checkSchema(client: pg.Client): Promise<void> {
  const res = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ~ $1`,
    [SEALED_NAME_PATTERN],
  );
  const present = new Set(res.rows.map((r) => `${r.table_name}.${r.column_name}`));
  const known = new Set(SEALED_COLUMNS.map((c) => `${c.table}.${c.column}`));
  const unknown = [...present].filter((c) => !known.has(c)).sort();
  if (unknown.length) {
    throw new RotationRefused(
      'schema',
      `The database has column(s) that look sealed but are not in the rotation list (apps/api/src/ops/sealed-columns.ts): ${unknown.join(', ')}. Nothing was changed.`,
    );
  }
  const missing = [...known].filter((c) => !present.has(c)).sort();
  if (missing.length) {
    throw new RotationRefused('schema', `The database is missing sealed column(s) ${missing.join(', ')}: run the migrations first (pnpm --filter ./apps/api migrate). Nothing was changed.`);
  }
}

/**
 * Re-encrypts every sealed column from `oldKey` to `newKey` in ONE transaction. Every value must
 * decrypt with the old key first, or nothing is changed. The tables are locked against writes for
 * the duration (reads continue). One audit entry per organization records the counts and the
 * key ids — never a key or a value.
 */
export async function rotateEncryptionKey(opts: RotateOptions): Promise<RotateResult> {
  const log = opts.log ?? (() => undefined);
  const batchSize = opts.batchSize ?? 500;
  if (opts.oldKey.equals(opts.newKey)) throw new RotationRefused('same_key', 'The new key is the same as the old key. Nothing was changed.');
  const oldKeyId = keyId(opts.oldKey);
  const newKeyId = keyId(opts.newKey);

  const client = new pg.Client({ connectionString: opts.databaseUrl, application_name: 'nigafiy-rotate-key' });
  await client.connect();
  try {
    const sessions = await otherSessions(client);
    const api = sessions.filter((s) => s.api);
    if (api.length && !opts.force) {
      throw new RotationRefused(
        'api_connected',
        `The API is connected to this database (${describeSessions(api)}). Stop the API (or the Nigafiy engine stack) first: a running API keeps sealing new secrets with the old key. Use --force only if those sessions are not an API. Nothing was changed.`,
      );
    }
    await checkSchema(client);

    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '15s'`);
      const tables = [...new Set(SEALED_COLUMNS.map((c) => c.table))];
      // Blocks INSERT/UPDATE/DELETE by anyone else until COMMIT, so no value can be written with the
      // old key behind our back; plain reads go on.
      await client.query(`LOCK TABLE ${tables.map(ident).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);

      // 1. Read and decrypt everything with the old key. Any failure → refuse, nothing changed.
      const plain = new Map<SealedColumn, Row[]>();
      const failures: string[] = [];
      let alreadyNew = 0;
      for (const c of SEALED_COLUMNS) {
        const keyCols = c.key.map((k) => `${ident(k)}::text`).join(', ');
        const orgCol = c.organizationColumn ? `${ident(c.organizationColumn)}::text` : 'NULL::text';
        const res = await client.query({
          text: `SELECT ${keyCols}, ${orgCol}, ${ident(c.column)} FROM ${ident(c.table)} WHERE ${ident(c.column)} IS NOT NULL`,
          rowMode: 'array',
        });
        const rows: Row[] = [];
        for (const r of res.rows as (string | null)[][]) {
          const key = r.slice(0, c.key.length) as string[];
          const org = r[c.key.length] ?? null;
          const stored = r[c.key.length + 1] as string;
          try {
            rows.push({ key, org, plain: openWithKey(opts.oldKey, stored) });
          } catch {
            failures.push(where(c, key));
            try {
              openWithKey(opts.newKey, stored);
              alreadyNew++;
            } catch {
              // neither key
            }
          }
        }
        plain.set(c, rows);
      }
      if (failures.length) {
        const shown = failures.slice(0, 20).join('\n  ');
        const more = failures.length > 20 ? `\n  … and ${failures.length - 20} more` : '';
        const hint = alreadyNew ? ` ${alreadyNew} of them already decrypt with the NEW key — was this database already rotated?` : '';
        throw new RotationRefused('undecryptable', `${failures.length} sealed value(s) do not decrypt with the old key:\n  ${shown}${more}\n${hint}Nothing was changed.`);
      }

      const columns: ColumnCount[] = SEALED_COLUMNS.map((c) => ({ table: c.table, column: c.column, values: plain.get(c)!.length }));
      const total = columns.reduce((n, c) => n + c.values, 0);
      for (const c of columns) log(`  ${c.table}.${c.column}: ${c.values}`);

      if (opts.dryRun) {
        await client.query('ROLLBACK');
        return { dryRun: true, columns, total, auditRows: 0, oldKeyId, newKeyId };
      }

      // 2. Re-seal with the new key and write back, in batches, all inside the transaction.
      const perOrg = new Map<string, number>();
      for (const c of SEALED_COLUMNS) {
        const rows = plain.get(c)!;
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const sealed = batch.map((r) => {
            const s = sealWithKey(opts.newKey, r.plain);
            if (openWithKey(opts.newKey, s) !== r.plain) throw new Error(`re-encryption check failed for ${where(c, r.key)}`);
            return s;
          });
          const keyArrays = c.key.map((_, k) => batch.map((r) => r.key[k]!));
          const vals = c.key.map((_, k) => `$${k + 1}::text[]`).join(', ');
          const cols = c.key.map((_, k) => `k${k}`).join(', ');
          const match = c.key.map((k, j) => `t.${ident(k)}::text = v.k${j}`).join(' AND ');
          const res = await client.query(
            `UPDATE ${ident(c.table)} AS t SET ${ident(c.column)} = v.sealed
               FROM unnest(${vals}, $${c.key.length + 1}::text[]) AS v(${cols}, sealed)
              WHERE ${match}`,
            [...keyArrays, sealed],
          );
          if (res.rowCount !== batch.length) throw new Error(`${c.table}.${c.column}: updated ${res.rowCount} rows, expected ${batch.length}`);
        }
        for (const r of rows) if (r.org) perOrg.set(r.org, (perOrg.get(r.org) ?? 0) + 1);
      }

      // 3. Read back: every value must now decrypt with the new key.
      for (const c of SEALED_COLUMNS) {
        const res = await client.query({ text: `SELECT ${ident(c.column)} FROM ${ident(c.table)} WHERE ${ident(c.column)} IS NOT NULL`, rowMode: 'array' });
        if (res.rows.length !== plain.get(c)!.length) throw new Error(`${c.table}.${c.column}: row count changed during rotation`);
        for (const [stored] of res.rows as string[][]) openWithKey(opts.newKey, stored!);
      }

      // 4. Audit, same transaction.
      const auditRows = await auditOperation(client, 'security.encryption_key_rotated', { type: 'installation' }, (orgId) => ({
        tool: 'rotate-key',
        old_key_id: oldKeyId,
        new_key_id: newKeyId,
        values_rotated_total: total,
        values_rotated_in_organization: perOrg.get(orgId) ?? 0,
        columns,
        forced: Boolean(opts.force && api.length),
        ...(opts.operator ? { operator_os_user: opts.operator.osUser, operator_host: opts.operator.host } : {}),
      }));

      await client.query('COMMIT');
      return { dryRun: false, columns, total, auditRows, oldKeyId, newKeyId };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
