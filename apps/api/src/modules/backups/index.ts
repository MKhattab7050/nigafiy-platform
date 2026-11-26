import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { AppError, auth, parse, requireRole } from '../../common/http.ts';
import { keyId } from '../../common/secret-box.ts';
import { env } from '../../config/env.ts';
import { defineModule } from '../../infrastructure/module.ts';
import { withSystem, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { OpsRefused } from '../../ops/backup.ts';
import {
  BACKUP_EXT,
  inspectBackup,
  MIN_PASSPHRASE,
  parseBackupName,
  RestoreNeedsKey,
  restoreLogicalBackup,
  sealKeyEnvelope,
  WrongPassphrase,
} from '../../ops/logical-backup.ts';
import {
  backupRunning,
  backupStatus,
  checkFolderShape,
  currentKey,
  folderOf,
  isRestoring,
  loadSettings,
  prepareFolder,
  runBackup,
  runScheduledBackups,
  setRestoring,
  soleOrganization,
} from './service.ts';

/**
 * Backups from the app (UX review 2026-11-26, item 15). Owner only, and only on a single-organization
 * installation (an installed copy); elsewhere GET answers { available: false } and the rest 403.
 *
 *   GET    /backups                   settings, last run, the files in the folder
 *   PUT    /backups/settings          { folder (absolute local path | null = default), schedule, hour, weekday, keep }
 *   POST   /backups/run               "Back up now" (waits for the file)
 *   PUT    /backups/key               { passphrase } → every backup carries the encryption key sealed with it
 *   DELETE /backups/key               backups no longer carry the key
 *   GET    /backups/inspect?file=     what restoring that file needs (passphrase? newer version?)
 *   POST   /backups/restore           { file, passphrase?, allow_unreadable_secrets?, confirm: true }
 *
 * `file` is a backup's name in the folder, or an absolute path to a .nigafiy-backup file (one copied
 * from another PC).
 */

const router: Router = Router();

async function gate(req: Request, _res: Response, next: NextFunction) {
  const ctx = auth(req);
  const sole = await withSystem(soleOrganization);
  if (sole !== ctx.organizationId) throw new AppError(403, 'dbbackup_unavailable', 'Backups from the app are available on an installed copy with one organization.');
  next();
}

router.get('/backups', requireRole('owner'), async (req, res) => {
  const ctx = auth(req);
  const sole = await withSystem(soleOrganization);
  if (sole !== ctx.organizationId) return void res.json({ available: false });
  res.json(await backupStatus(await withSystem(loadSettings)));
});

const settingsBody = z.object({
  folder: z.string().trim().min(1).max(400).nullable(),
  schedule: z.enum(['off', 'daily', 'weekly']),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6),
  keep: z.number().int().min(1).max(100),
});

router.put('/backups/settings', requireRole('owner'), gate, async (req, res) => {
  const body = parse(settingsBody, req.body);
  if (body.folder !== null) {
    const bad = checkFolderShape(body.folder);
    if (bad) {
      throw new AppError(
        400,
        'dbbackup_folder_invalid',
        bad === 'network' ? 'Choose a folder on this computer or a USB drive, not a network share.' : 'Enter the full path of a folder, for example D:\\Nigafiy backups.',
      );
    }
    try {
      await prepareFolder(body.folder);
    } catch (err) {
      throw new AppError(400, 'dbbackup_folder_unwritable', `Nigafiy cannot write to that folder: ${(err as Error).message}`);
    }
  }
  await withSystem(async (db) => {
    await loadSettings(db);
    await db.query(`UPDATE backup_settings SET folder = $1, schedule = $2, hour = $3, weekday = $4, keep = $5, updated_at = now() WHERE id`, [
      body.folder,
      body.schedule,
      body.hour,
      body.weekday,
      body.keep,
    ]);
  });
  await withTenant(auth(req).organizationId, (db) => audit(db, req, 'backups.settings_updated', { type: 'installation' }, body));
  res.json(await backupStatus(await withSystem(loadSettings)));
});

router.post('/backups/run', requireRole('owner'), gate, async (req, res) => {
  if (isRestoring()) throw new AppError(409, 'dbbackup_restore_running', 'A restore is in progress.');
  try {
    const r = await runBackup('manual');
    await withTenant(auth(req).organizationId, (db) =>
      audit(db, req, 'backups.created', { type: 'installation' }, { file: path.basename(r.file), bytes: r.bytes, key_included: r.keyIncluded }),
    );
    res.json({ file: path.basename(r.file), bytes: r.bytes, sha256: r.sha256, rows: r.rows, key_included: r.keyIncluded });
  } catch (err) {
    throw new AppError(500, 'dbbackup_failed', `The backup could not be written: ${(err as Error).message}`);
  }
});

const keyBody = z.object({ passphrase: z.string().min(MIN_PASSPHRASE).max(200) });

router.put('/backups/key', requireRole('owner'), gate, async (req, res) => {
  const { passphrase } = parse(keyBody, req.body);
  const key = currentKey();
  const envelope = sealKeyEnvelope(key, passphrase);
  await withSystem(async (db) => {
    await loadSettings(db);
    await db.query(`UPDATE backup_settings SET key_envelope = $1, key_id = $2, updated_at = now() WHERE id`, [JSON.stringify(envelope), keyId(key)]);
  });
  await withTenant(auth(req).organizationId, (db) => audit(db, req, 'backups.key_protected', { type: 'installation' }));
  res.json(await backupStatus(await withSystem(loadSettings)));
});

router.delete('/backups/key', requireRole('owner'), gate, async (req, res) => {
  await withSystem(async (db) => {
    await loadSettings(db);
    await db.query(`UPDATE backup_settings SET key_envelope = NULL, key_id = NULL, updated_at = now() WHERE id`);
  });
  await withTenant(auth(req).organizationId, (db) => audit(db, req, 'backups.key_removed', { type: 'installation' }));
  res.json(await backupStatus(await withSystem(loadSettings)));
});

/** A backup's name in the folder, or an absolute path to one; refuses anything else. */
async function resolveFile(file: string): Promise<string> {
  let full: string;
  if (parseBackupName(file)) {
    full = path.join(folderOf(await withSystem(loadSettings)), file);
  } else {
    const shape = checkFolderShape(file);
    if (shape || !file.toLowerCase().endsWith(BACKUP_EXT)) throw new AppError(400, 'dbbackup_file_invalid', `Choose a ${BACKUP_EXT} file by its full path.`);
    full = path.resolve(file);
  }
  if (!existsSync(full) || !statSync(full).isFile()) throw new AppError(404, 'dbbackup_file_not_found', 'That backup file was not found.');
  return full;
}

const inspectQuery = z.object({ file: z.string().min(1).max(500) });

router.get('/backups/inspect', requireRole('owner'), gate, async (req, res) => {
  const { file } = parse(inspectQuery, req.query);
  const full = await resolveFile(file);
  try {
    const r = await inspectBackup(full, currentKey());
    res.json({
      file: path.basename(full),
      created_at: r.header.created_at,
      app_version: r.header.app_version,
      kind: r.header.kind,
      same_key: r.sameKey,
      needs_passphrase: r.needsPassphrase,
      key_missing: r.keyMissing,
      newer_version: r.newerVersion,
    });
  } catch (err) {
    if (err instanceof OpsRefused) throw new AppError(400, 'dbbackup_file_invalid', err.message);
    throw err;
  }
});

const restoreBody = z.object({
  file: z.string().min(1).max(500),
  passphrase: z.string().max(200).optional(),
  allow_unreadable_secrets: z.boolean().default(false),
  confirm: z.literal(true),
});

router.post('/backups/restore', requireRole('owner'), gate, async (req, res) => {
  const body = parse(restoreBody, req.body);
  const full = await resolveFile(body.file);
  if (isRestoring()) throw new AppError(409, 'dbbackup_restore_running', 'A restore is already in progress.');
  if (backupRunning()) throw new AppError(409, 'dbbackup_running', 'A backup is being written. Try again in a moment.');
  const ctx = auth(req);
  setRestoring(true);
  try {
    const r = await restoreLogicalBackup({
      databaseUrl: env.DATABASE_URL,
      appDatabaseUrl: env.APP_DATABASE_URL,
      file: full,
      currentKey: currentKey(),
      passphrase: body.passphrase,
      allowUnreadableSecrets: body.allow_unreadable_secrets,
      operator: { restored_by: ctx.userEmail, operator_host: os.hostname() },
      log: (line) => logger.info({ file: path.basename(full) }, line),
    });
    res.json({
      backup_created_at: r.backupCreatedAt,
      previous_database: r.previousDatabase,
      rows: r.rows,
      key_rotated: r.keyRotated,
      secrets_readable: r.secretsReadable,
      migrations_applied: r.migrationsApplied.length,
    });
  } catch (err) {
    if (err instanceof RestoreNeedsKey) {
      throw new AppError(409, err.reason === 'passphrase_needed' ? 'dbbackup_passphrase_needed' : 'dbbackup_key_missing', err.message);
    }
    if (err instanceof WrongPassphrase) throw new AppError(400, 'dbbackup_wrong_passphrase', err.message);
    if (err instanceof OpsRefused) {
      if (/newer version/.test(err.message)) throw new AppError(409, 'dbbackup_newer_version', err.message);
      throw new AppError(400, 'dbbackup_file_invalid', err.message);
    }
    logger.error({ err }, 'restore failed');
    throw new AppError(500, 'dbbackup_restore_failed', `The restore failed and nothing was changed: ${(err as Error).message}`);
  } finally {
    setRestoring(false);
  }
});

export const backupsModule = defineModule({
  name: 'backups',
  api: router,
  jobs: [{ name: 'scheduled-backups', everyMs: 5 * 60_000, lockKey: 727301, run: () => runScheduledBackups() }],
});
