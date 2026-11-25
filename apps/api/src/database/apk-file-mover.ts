import { Readable } from 'node:stream';
import type pg from 'pg';
import { type FileStore, fileStore } from '../infrastructure/file-store.ts';

/**
 * Runs inside the transaction of migration 048_android_apk_files.sql, just before its SQL
 * (database/migrate.ts). Copies every fleet_android_apks.content into the file store, one row at a
 * time, and lists the moved ids in a temporary table; the SQL then refuses to drop the column unless
 * every row was moved, sets storage_key, and drops `content`.
 *
 * Idempotent and safe if interrupted: files are content-addressed and written atomically (temp file,
 * fsync, check, rename), and an existing intact file is kept. If anything fails, the transaction
 * rolls back and `content` is untouched; the next start runs the mover again. Files written by a
 * failed run are either reused by the next run or removed by the orphan sweep.
 *
 * Memory: PostgreSQL hands back one bytea value whole, so one APK (≤ 100 MiB) is in memory at a time.
 */
export async function moveApkContentToFiles(client: pg.Client, log: (msg: string) => void, store: FileStore = fileStore()): Promise<void> {
  await client.query('CREATE TEMP TABLE _apk_files_moved (id uuid PRIMARY KEY) ON COMMIT DROP');
  const hasContent = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'fleet_android_apks' AND column_name = 'content'`,
  );
  if (!hasContent.rowCount) return;
  const rows = (
    await client.query<{ id: string; organization_id: string; sha256: string; size_bytes: string }>(
      `SELECT id, organization_id, sha256, size_bytes::text FROM fleet_android_apks ORDER BY created_at, id`,
    )
  ).rows;
  for (const r of rows) {
    const content = (await client.query<{ content: Buffer }>(`SELECT content FROM fleet_android_apks WHERE id = $1`, [r.id])).rows[0]!.content;
    const staged = await store.stage('apks', r.organization_id, Readable.from([content]), { maxBytes: Number(r.size_bytes) });
    if (staged.sha256 !== r.sha256 || staged.size !== Number(r.size_bytes)) {
      await staged.discard();
      throw new Error(`APK ${r.id}: the stored bytes do not match the recorded size and SHA-256; nothing was changed`);
    }
    await staged.commit();
    await client.query('INSERT INTO _apk_files_moved (id) VALUES ($1)', [r.id]);
  }
  if (rows.length) log(`moved ${rows.length} APK file(s) from the database to the file store`);
}
