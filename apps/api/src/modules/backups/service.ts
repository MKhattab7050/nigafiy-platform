import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { keyId } from '../../common/secret-box.ts';
import { env } from '../../config/env.ts';
import { type Db, withSystem } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { defaultBackupDir } from '../../ops/backup.ts';
import {
  BACKUP_EXT,
  type BackupFileInfo,
  exportDatabase,
  type ExportResult,
  type KeyEnvelope,
  listBackups,
  pruneAutoBackups,
} from '../../ops/logical-backup.ts';

/**
 * Backups from the app (UX review 2026-11-26, item 15; migration 060). The settings row is one per
 * installation; everything here acts only on a single-organization installation (an installed copy),
 * so a hosted server with many organizations never lets one organization's owner write the whole
 * database to a folder.
 */

export const APP_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

export const currentKey = (): Buffer => Buffer.from(env.APP_ENCRYPTION_KEY, 'hex');

export interface BackupSettingsRow {
  folder: string | null;
  schedule: 'off' | 'daily' | 'weekly';
  hour: number;
  weekday: number;
  keep: number;
  key_envelope: KeyEnvelope | null;
  key_id: string | null;
  last_run_at: Date | null;
  last_auto_at: Date | null;
  last_ok_at: Date | null;
  last_file: string | null;
  last_bytes: string | null;
  last_error: string | null;
}

export async function loadSettings(db: Db): Promise<BackupSettingsRow> {
  await db.query('INSERT INTO backup_settings (id) VALUES (true) ON CONFLICT DO NOTHING');
  return (await db.query<BackupSettingsRow>('SELECT * FROM backup_settings WHERE id')).rows[0]!;
}

/** The only organization of this installation, or null when there are none or several. */
export async function soleOrganization(db: Db): Promise<string | null> {
  const r = await db.query<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 2');
  return r.rows.length === 1 ? r.rows[0]!.id : null;
}

export const folderOf = (s: Pick<BackupSettingsRow, 'folder'>): string => s.folder ?? defaultBackupDir();

/**
 * A folder the owner typed: an absolute local path. Network shares (\\server\share) are refused: the
 * backup holds every stored secret's ciphertext and, with a passphrase, the key that opens them.
 */
export function checkFolderShape(folder: string): string | null {
  if (folder.includes('\0')) return 'invalid';
  if (/^[\\/]{2}/.test(folder)) return 'network';
  if (!path.isAbsolute(folder)) return 'relative';
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(folder)) return 'relative';
  return null;
}

/** Creates the folder if needed and proves it is writable (a small file written and removed). */
export async function prepareFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  const probe = path.join(folder, `.nigafiy-write-test-${process.pid}`);
  await writeFile(probe, 'ok');
  await rm(probe, { force: true });
}

/**
 * When the schedule last fell due at or before `now` (server local time), or null when off.
 * Daily: today's `hour`:00, else yesterday's. Weekly: the latest `weekday` at `hour`:00.
 */
export function lastDue(s: Pick<BackupSettingsRow, 'schedule' | 'hour' | 'weekday'>, now: Date): Date | null {
  if (s.schedule === 'off') return null;
  const d = new Date(now);
  d.setHours(s.hour, 0, 0, 0);
  if (s.schedule === 'daily') {
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }
  d.setDate(d.getDate() - ((d.getDay() - s.weekday + 7) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}

/** A scheduled backup is due when none ran since the last due time (a PC that was off catches up). */
export function isDue(s: Pick<BackupSettingsRow, 'schedule' | 'hour' | 'weekday' | 'last_auto_at'>, now: Date): boolean {
  const due = lastDue(s, now);
  return due !== null && (s.last_auto_at === null || s.last_auto_at < due);
}

let running: Promise<ExportResult> | null = null;
export const backupRunning = (): boolean => running !== null;
let restoring = false;
export const setRestoring = (on: boolean) => {
  restoring = on;
};
export const isRestoring = () => restoring;

/** Runs one backup now (one at a time per API process), records the outcome, prunes old scheduled ones. */
export function runBackup(kind: 'manual' | 'auto'): Promise<ExportResult> {
  if (restoring) return Promise.reject(Object.assign(new Error('A restore is in progress.'), { code: 'restore_running' }));
  if (running) return running;
  running = (async () => {
    const s = await withSystem(loadSettings);
    const folder = folderOf(s);
    const startedAt = new Date();
    try {
      await prepareFolder(folder);
      const r = await exportDatabase({
        databaseUrl: env.DATABASE_URL,
        outDir: folder,
        kind,
        currentKey: currentKey(),
        keyEnvelope: s.key_envelope,
        appVersion: APP_VERSION,
        now: startedAt,
      });
      if (kind === 'auto') await pruneAutoBackups(folder, s.keep);
      await withSystem((db) =>
        db.query(
          `UPDATE backup_settings SET last_run_at = $1, last_ok_at = now(), last_file = $2, last_bytes = $3, last_error = NULL,
                  last_auto_at = CASE WHEN $4 THEN $1 ELSE last_auto_at END WHERE id`,
          [startedAt, path.basename(r.file), r.bytes, kind === 'auto'],
        ),
      );
      logger.info({ file: r.file, bytes: r.bytes, rows: r.rows, kind }, 'backup written');
      return r;
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      await withSystem((db) =>
        db.query(`UPDATE backup_settings SET last_run_at = $1, last_error = $2, last_auto_at = CASE WHEN $3 THEN $1 ELSE last_auto_at END WHERE id`, [
          startedAt,
          message,
          kind === 'auto',
        ]),
      ).catch(() => undefined);
      logger.warn({ err: message, kind }, 'backup failed');
      throw err;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** The scheduler job: on a single-organization installation, a scheduled backup when one is due. */
export async function runScheduledBackups(now = new Date()): Promise<void> {
  const s = await withSystem(async (db) => ((await soleOrganization(db)) ? loadSettings(db) : null));
  if (!s || restoring || running || !isDue(s, now)) return;
  await runBackup('auto').catch(() => undefined);
}

export interface BackupStatus {
  available: boolean;
  folder: string;
  default_folder: string;
  custom_folder: boolean;
  schedule: BackupSettingsRow['schedule'];
  hour: number;
  weekday: number;
  keep: number;
  /** A passphrase-protected copy of the encryption key goes into every backup. */
  key_protected: boolean;
  /** A passphrase was set, but for an older key (after a key rotation): set it again. */
  key_stale: boolean;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_file: string | null;
  last_bytes: number | null;
  last_error: string | null;
  next_due_at: string | null;
  running: boolean;
  restoring: boolean;
  files: BackupFileInfo[];
  extension: string;
}

function nextDue(s: BackupSettingsRow, now: Date): Date | null {
  const last = lastDue(s, now);
  if (!last) return null;
  if (isDue(s, now)) return now;
  const n = new Date(last);
  n.setDate(n.getDate() + (s.schedule === 'daily' ? 1 : 7));
  return n;
}

export async function backupStatus(s: BackupSettingsRow, now = new Date()): Promise<BackupStatus> {
  const folder = folderOf(s);
  const current = keyId(currentKey());
  return {
    available: true,
    folder,
    default_folder: defaultBackupDir(),
    custom_folder: s.folder !== null,
    schedule: s.schedule,
    hour: s.hour,
    weekday: s.weekday,
    keep: s.keep,
    key_protected: s.key_envelope !== null && s.key_id === current,
    key_stale: s.key_envelope !== null && s.key_id !== current,
    last_run_at: s.last_run_at?.toISOString() ?? null,
    last_ok_at: s.last_ok_at?.toISOString() ?? null,
    last_file: s.last_file,
    last_bytes: s.last_bytes === null ? null : Number(s.last_bytes),
    last_error: s.last_error,
    next_due_at: nextDue(s, now)?.toISOString() ?? null,
    running: backupRunning(),
    restoring,
    files: existsSync(folder) ? await listBackups(folder).catch(() => []) : [],
    extension: BACKUP_EXT,
  };
}
