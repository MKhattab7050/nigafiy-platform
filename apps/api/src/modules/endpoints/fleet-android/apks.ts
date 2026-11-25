import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { AndroidApk } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { withTenant } from '../../../infrastructure/db.ts';
import type { EndpointContext } from '../schema.ts';

// APKs an admin uploads to push to Device Owner phones (fleet_android_apks, migration 045). The
// bytes live in the database (≤ 100 MiB each); only name, size and SHA-256 reach the audit log.
// An agent downloads an APK only for an install command it was given (GET /api/v1/agent/android/apks/:id),
// and checks size and SHA-256 before installing (agents/android-agent core/Gateway.kt).

export const MAX_APK_BYTES = 100 * 1024 * 1024;
const APK_COLUMNS = 'id, name, file_name, size_bytes::float8 AS size_bytes, sha256, uploaded_by_email, created_at';

/** An APK is a ZIP archive: it starts with the local file header "PK\x03\x04". */
export function looksLikeApk(bytes: Buffer): boolean {
  return bytes.length >= 30 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function uploadApk(req: Request, ctx: AuthContext, meta: { name: string; file_name: string }, bytes: Buffer): Promise<AndroidApk> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new AppError(422, 'apk_empty', 'Send the APK file as the request body (Content-Type: application/vnd.android.package-archive)');
  if (bytes.length > MAX_APK_BYTES) throw new AppError(413, 'apk_too_large', 'An APK can be at most 100 MiB');
  if (!looksLikeApk(bytes)) throw new AppError(422, 'apk_invalid', 'The file is not an APK (an APK is a ZIP archive)');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return withTenant(ctx.organizationId, async (db) => {
    const existing = (await db.query<AndroidApk>(`SELECT ${APK_COLUMNS} FROM fleet_android_apks WHERE sha256 = $1`, [sha256])).rows[0];
    if (existing) throw new AppError(409, 'apk_exists', `This APK is already uploaded as "${existing.name}"`);
    const apk = (
      await db.query<AndroidApk>(
        `INSERT INTO fleet_android_apks (organization_id, name, file_name, size_bytes, sha256, content, uploaded_by, uploaded_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${APK_COLUMNS}`,
        [ctx.organizationId, meta.name, meta.file_name, bytes.length, sha256, bytes, ctx.userId, ctx.userEmail],
      )
    ).rows[0]!;
    await audit(db, req, 'fleet.android_apk_uploaded', { type: 'android_apk', id: apk.id }, { name: apk.name, file_name: apk.file_name, size_bytes: apk.size_bytes, sha256 });
    return apk;
  });
}

export async function listApks(ctx: AuthContext): Promise<AndroidApk[]> {
  return withTenant(ctx.organizationId, async (db) => (await db.query<AndroidApk>(`SELECT ${APK_COLUMNS} FROM fleet_android_apks ORDER BY created_at DESC LIMIT 200`)).rows);
}

export async function deleteApk(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const gone = (await db.query<{ name: string; sha256: string }>(`DELETE FROM fleet_android_apks WHERE id = $1 RETURNING name, sha256`, [id])).rows[0];
    if (!gone) throw notFound('APK');
    await audit(db, req, 'fleet.android_apk_deleted', { type: 'android_apk', id }, { name: gone.name, sha256: gone.sha256 });
  });
}

/**
 * The agent side: the bytes of an APK this endpoint was told to install by a command that is still
 * open (pending or delivered). Anything else is a 404, so a credential cannot list or fetch APKs.
 */
export async function agentApk(ep: EndpointContext, apkId: string): Promise<{ bytes: Buffer; fileName: string; sha256: string }> {
  return withTenant(ep.organizationId, async (db) => {
    const r = (
      await db.query<{ content: Buffer; file_name: string; sha256: string }>(
        `SELECT a.content, a.file_name, a.sha256
           FROM fleet_android_apks a
          WHERE a.id = $2
            AND EXISTS (SELECT 1 FROM endpoint_commands c
                         WHERE c.endpoint_id = $1 AND c.kind = 'android_install_apk' AND c.status IN ('pending', 'delivered')
                           AND c.payload->>'apk_id' = a.id::text)`,
        [ep.id, apkId],
      )
    ).rows[0];
    if (!r) throw notFound('APK');
    return { bytes: r.content, fileName: r.file_name, sha256: r.sha256 };
  });
}
