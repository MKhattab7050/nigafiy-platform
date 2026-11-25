import type { Readable } from 'node:stream';
import type { Request } from 'express';
import type { AndroidApk } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { type FileStore, FileStoreError, type StagedFile, fileStore, storageKey } from '../../../infrastructure/file-store.ts';
import { logger } from '../../../infrastructure/logger.ts';
import type { EndpointContext } from '../schema.ts';

// APKs an admin uploads to push to Device Owner phones (fleet_android_apks, migrations 045 and 048).
// The bytes live in the file store (infrastructure/file-store.ts: <files>/apks/<org id>/<sha256>);
// the row keeps name, size, SHA-256 and the storage key. Only name, size and SHA-256 reach the audit
// log. An agent downloads an APK only for an install command it was given
// (GET /api/v1/agent/android/apks/:id) and checks size and SHA-256 before installing
// (agents/android-agent core/Gateway.kt); the server checks both while streaming too.

export const MAX_APK_BYTES = 100 * 1024 * 1024;
const APK_COLUMNS = 'id, name, file_name, size_bytes::float8 AS size_bytes, sha256, uploaded_by_email, created_at';

export const APK_FILE_MESSAGES = {
  apk_file_missing: 'The stored APK file is missing on the server; upload the same APK file again to repair it',
  apk_file_corrupt: 'The stored APK file is damaged (its size or SHA-256 does not match); upload the same APK file again to repair it',
} as const;

/** An APK is a ZIP archive: it starts with the local file header "PK\x03\x04". */
export function looksLikeApk(bytes: Buffer): boolean {
  return bytes.length >= 30 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Serialises everything that creates, deletes or sweeps one stored file (same key → same lock), so
 * a delete or the sweep never removes a file another transaction is about to reference.
 */
export async function lockStorageKey(db: Db, key: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 727174))`, [key]);
}

async function referenced(db: Db, key: string): Promise<boolean> {
  return Boolean((await db.query(`SELECT 1 FROM fleet_android_apks WHERE storage_key = $1 LIMIT 1`, [key])).rowCount);
}

/**
 * POST /fleet/android/apks: the body is streamed to a temporary file, checked, then stored by content.
 * The same bytes again are refused (apk_exists), unless the stored copy is missing or damaged: then
 * the upload repairs it (same SHA-256, so the very same bytes) and the existing APK is returned.
 */
export async function uploadApk(
  req: Request,
  ctx: AuthContext,
  meta: { name: string; file_name: string },
  body: Readable,
  store: FileStore = fileStore(),
): Promise<{ apk: AndroidApk; repaired: boolean }> {
  let staged: StagedFile;
  try {
    staged = await store.stage('apks', ctx.organizationId, body, { maxBytes: MAX_APK_BYTES });
  } catch (err) {
    if (err instanceof FileStoreError && err.problem === 'too_large') throw new AppError(413, 'apk_too_large', 'An APK can be at most 100 MiB');
    if (err instanceof FileStoreError && err.problem === 'empty') throw new AppError(422, 'apk_empty', 'Send the APK file as the request body (Content-Type: application/vnd.android.package-archive)');
    throw err;
  }
  try {
    if (!looksLikeApk(staged.head)) throw new AppError(422, 'apk_invalid', 'The file is not an APK (an APK is a ZIP archive)');
    return await withTenant(ctx.organizationId, async (db) => {
      const key = storageKey('apks', ctx.organizationId, staged.sha256);
      await lockStorageKey(db, key);
      const existing = (await db.query<AndroidApk & { storage_key: string }>(`SELECT ${APK_COLUMNS}, storage_key FROM fleet_android_apks WHERE sha256 = $1`, [staged.sha256])).rows[0];
      if (existing) {
        const { storage_key: existingKey, ...apk } = existing;
        const state = await store.verify(existingKey, { sha256: apk.sha256, size: Number(apk.size_bytes) });
        if (state === 'ok') throw new AppError(409, 'apk_exists', `This APK is already uploaded as "${apk.name}"`);
        await staged.commit();
        await audit(db, req, 'fleet.android_apk_file_repaired', { type: 'android_apk', id: apk.id }, { name: apk.name, sha256: apk.sha256, was: state });
        return { apk, repaired: true };
      }
      await staged.commit();
      try {
        const apk = (
          await db.query<AndroidApk>(
            `INSERT INTO fleet_android_apks (organization_id, name, file_name, size_bytes, sha256, storage_key, uploaded_by, uploaded_by_email)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${APK_COLUMNS}`,
            [ctx.organizationId, meta.name, meta.file_name, staged.size, staged.sha256, key, ctx.userId, ctx.userEmail],
          )
        ).rows[0]!;
        await audit(db, req, 'fleet.android_apk_uploaded', { type: 'android_apk', id: apk.id }, { name: apk.name, file_name: apk.file_name, size_bytes: apk.size_bytes, sha256: staged.sha256 });
        return { apk, repaired: false };
      } catch (err) {
        // Still under the key's lock and nothing references the file: take it back out.
        if (!(await referenced(db, key).catch(() => true))) await store.remove(key).catch(() => undefined);
        // The same bytes uploaded twice at the same moment: the second one loses on the unique index.
        if ((err as { code?: string }).code === '23505') throw new AppError(409, 'apk_exists', 'This APK is already uploaded');
        throw err;
      }
    });
  } finally {
    await staged.discard();
  }
}

export async function listApks(ctx: AuthContext): Promise<AndroidApk[]> {
  return withTenant(ctx.organizationId, async (db) => (await db.query<AndroidApk>(`SELECT ${APK_COLUMNS} FROM fleet_android_apks ORDER BY created_at DESC LIMIT 200`)).rows);
}

/** DELETE /fleet/android/apks/:id: the row, and its file when no other row references it. */
export async function deleteApk(req: Request, ctx: AuthContext, id: string, store: FileStore = fileStore()): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const gone = (await db.query<{ name: string; sha256: string; storage_key: string }>(`DELETE FROM fleet_android_apks WHERE id = $1 RETURNING name, sha256, storage_key`, [id])).rows[0];
    if (!gone) throw notFound('APK');
    await lockStorageKey(db, gone.storage_key);
    let fileRemoved = false;
    if (!(await referenced(db, gone.storage_key))) fileRemoved = await store.remove(gone.storage_key);
    await audit(db, req, 'fleet.android_apk_deleted', { type: 'android_apk', id }, { name: gone.name, sha256: gone.sha256, file_removed: fileRemoved });
  });
}

export interface ApkFileRef {
  id: string;
  storageKey: string;
  fileName: string;
  sha256: string;
  size: number;
}

/**
 * The agent side: the file of an APK this endpoint was told to install by a command that is still
 * open (pending or delivered). Anything else is a 404, so a credential cannot list or fetch APKs.
 */
export async function agentApk(ep: EndpointContext, apkId: string): Promise<ApkFileRef> {
  return withTenant(ep.organizationId, async (db) => {
    const r = (
      await db.query<{ id: string; storage_key: string; file_name: string; sha256: string; size_bytes: string }>(
        `SELECT a.id, a.storage_key, a.file_name, a.sha256, a.size_bytes::text
           FROM fleet_android_apks a
          WHERE a.id = $2
            AND EXISTS (SELECT 1 FROM endpoint_commands c
                         WHERE c.endpoint_id = $1 AND c.kind = 'android_install_apk' AND c.status IN ('pending', 'delivered')
                           AND c.payload->>'apk_id' = a.id::text)`,
        [ep.id, apkId],
      )
    ).rows[0];
    if (!r) throw notFound('APK');
    return { id: r.id, storageKey: r.storage_key, fileName: r.file_name, sha256: r.sha256, size: Number(r.size_bytes) };
  });
}

/** GET /fleet/android/apks/:id/file (admin): the stored APK, audited. */
export async function adminApk(req: Request, ctx: AuthContext, id: string): Promise<ApkFileRef> {
  return withTenant(ctx.organizationId, async (db) => {
    const r = (
      await db.query<{ id: string; name: string; storage_key: string; file_name: string; sha256: string; size_bytes: string }>(
        `SELECT id, name, storage_key, file_name, sha256, size_bytes::text FROM fleet_android_apks WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!r) throw notFound('APK');
    await audit(db, req, 'fleet.android_apk_downloaded', { type: 'android_apk', id: r.id }, { name: r.name, sha256: r.sha256 });
    return { id: r.id, storageKey: r.storage_key, fileName: r.file_name, sha256: r.sha256, size: Number(r.size_bytes) };
  });
}

export type ApkFileProblem = 'missing' | 'corrupt';

export const apkFileError = (problem: ApkFileProblem): AppError =>
  problem === 'missing' ? new AppError(409, 'apk_file_missing', APK_FILE_MESSAGES.apk_file_missing) : new AppError(409, 'apk_file_corrupt', APK_FILE_MESSAGES.apk_file_corrupt);

/**
 * An audit row for a stored APK file found missing or damaged (on install, on a phone's download or
 * an admin's). Its own transaction: it must survive the failing request.
 */
export async function auditApkFileProblem(
  organizationId: string,
  apk: { id: string; sha256: string },
  problem: ApkFileProblem,
  during: 'install' | 'agent_download' | 'admin_download',
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await withSystem((db) =>
      db.query(
        `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
         VALUES ($1, NULL, NULL, 'fleet.android_apk_file_problem', 'android_apk', $2, $3, 'system')`,
        [organizationId, apk.id, JSON.stringify({ problem, during, sha256: apk.sha256, ...extra })],
      ),
    );
  } catch (err) {
    logger.error({ err, apk_id: apk.id, problem }, 'could not audit an APK file problem');
  }
  logger.warn({ organization_id: organizationId, apk_id: apk.id, problem, during }, 'stored APK file is not usable');
}

/** The install action's check: the file is there with the recorded size (the full SHA-256 check runs on download). */
export async function checkApkFileForInstall(apk: { storage_key: string; size_bytes: number }, store: FileStore = fileStore()): Promise<ApkFileProblem | null> {
  const st = await store.stat(apk.storage_key);
  if (!st) return 'missing';
  return st.size === apk.size_bytes ? null : 'corrupt';
}

export interface ApkSweepSummary {
  orphans_removed: number;
  temp_removed: number;
  bytes_freed: number;
  /** Files of the store that are neither stored APKs nor temporary files: never touched. */
  others_kept: number;
}

/** Temporary files of interrupted writes are removed after this age (the longest upload is far shorter). */
export const TEMP_MAX_AGE_MS = 6 * 3600_000;
/** A stored file nothing references is removed after this age (the key lock already covers uploads in flight). */
export const ORPHAN_MIN_AGE_MS = 3600_000;

/**
 * Sweep of the APK files (at start and every 6 hours, modules/endpoints/index.ts): stored files that
 * no row references, and temporary files of interrupted writes. A referenced file is never removed:
 * each candidate is checked under its key's lock. One audit row per organization that lost files.
 */
export async function runApkFileSweep(store: FileStore = fileStore(), now: number = Date.now()): Promise<ApkSweepSummary> {
  const total: ApkSweepSummary = { orphans_removed: 0, temp_removed: 0, bytes_freed: 0, others_kept: 0 };
  const perOrg = new Map<string, ApkSweepSummary>();
  const bump = (org: string, f: (s: ApkSweepSummary) => void) => {
    let s = perOrg.get(org);
    if (!s) {
      s = { orphans_removed: 0, temp_removed: 0, bytes_freed: 0, others_kept: 0 };
      perOrg.set(org, s);
    }
    f(s);
    f(total);
  };
  for await (const e of store.scan('apks')) {
    const age = now - e.mtimeMs;
    if (e.kind === 'other') {
      bump(e.organizationId!, (s) => s.others_kept++);
    } else if (e.kind === 'temp') {
      if (age < TEMP_MAX_AGE_MS) continue;
      await store.removeEntry(e);
      bump(e.organizationId!, (s) => {
        s.temp_removed++;
        s.bytes_freed += e.size;
      });
    } else if (age >= ORPHAN_MIN_AGE_MS) {
      const removed = await withSystem(async (db) => {
        await lockStorageKey(db, e.key!);
        if (await referenced(db, e.key!)) return false;
        await store.removeEntry(e);
        return true;
      });
      if (removed) {
        bump(e.organizationId!, (s) => {
          s.orphans_removed++;
          s.bytes_freed += e.size;
        });
      }
    }
  }
  for (const [org, s] of perOrg) {
    if (!s.orphans_removed && !s.temp_removed) continue;
    // An organization that no longer exists has no audit log to write to.
    await withSystem((db) =>
      db.query(
        `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
         SELECT id, NULL, NULL, 'fleet.android_apk_files_swept', NULL, NULL, $2, 'system' FROM organizations WHERE id = $1`,
        [org, JSON.stringify(s)],
      ),
    );
  }
  if (total.orphans_removed || total.temp_removed) logger.info(total, 'APK file sweep');
  return total;
}
