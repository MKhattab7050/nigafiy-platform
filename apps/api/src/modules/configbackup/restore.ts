import type { Request } from 'express';
import { audit, auditSystem } from '../../common/audit.ts';
import { CONFIG_BACKUP_DRIVERS } from '../../common/config-backup-protocol.ts';
import { type CollectorContext, type ConfigRestoreResultItem, ItemRejected } from '../../common/collector-protocol.ts';
import { AppError, type AuthContext, notFound } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { diffLines } from './diff.ts';
import { RESTORE_COMMAND_TTL_MINUTES, RESTORE_TTL_MINUTES, RUN_TTL_MINUTES, type RestoreRequest } from './schema.ts';
import { expireStale, loadTarget, loadVersion, onlineCollector, queueRun, READINESS_ERRORS, readiness, type TargetRow } from './service.ts';

// Administrator-confirmed configuration restore.
//
//   1. preview: the diff from the latest backup to the chosen version, and whether a restore is
//      possible at all (vendor, readiness, pinned host key, sealed raw copy, nothing else running);
//   2. request (owner / admin): the device name typed as confirmation and a reason; a fresh backup
//      runs first (trigger 'restore'), so the state before the restore is always kept as a version;
//   3. after that backup succeeded (continueAfterBackup, called from ingest), the `config_restore`
//      command is queued. Its credentials and the version's sealed raw configuration are added only
//      when the site's collector picks it up (commands.ts), for a restore that is still pending;
//   4. the collector applies it with the vendor's commit-confirmed method and reads the
//      configuration back over a new SSH session. The read-back is stored as a normal version
//      (verify run); the restore is `verified` only when that version is the restored one.
//
// Only vendors with an automatic device-side rollback are supported: Juniper Junos
// (`commit confirmed`). Every other vendor gets an honest "restore not supported".

/** Driver → restore method. Must match the collector (internal/configbackup/restore.go). */
export const RESTORE_METHODS: Readonly<Record<string, string>> = { juniper_junos: 'junos_commit_confirmed' };

const effectiveDriver = (t: TargetRow) => t.driver ?? t.detected_driver;
const driverName = (id: string | null) => CONFIG_BACKUP_DRIVERS.find((d) => d.id === id)?.name ?? null;

export interface RestoreBlocker {
  code: string;
  message: string;
}

const RESTORE_COLUMNS = `r.id, r.target_id, r.version_id, r.version_number, r.sha256, r.method, r.status, r.reason, r.confirm_minutes, r.pre_run_id,
  r.verify_run_id, r.after_version_id, r.committed, r.confirmed, r.rolled_back, r.steps, r.error_kind, r.error, r.requested_by_email,
  r.created_at, r.expires_at, r.completed_at, (SELECT c.name FROM collectors c WHERE c.id = r.collector_id) AS collector_name`;

function unsupported(t: TargetRow): RestoreBlocker | null {
  const driver = effectiveDriver(t);
  if (!driver) {
    return {
      code: 'restore_vendor_unknown',
      message: 'The vendor of this device is not known yet. Run a backup or choose the vendor first; restore is only offered for vendors with an automatic rollback.',
    };
  }
  if (!RESTORE_METHODS[driver]) {
    return {
      code: 'restore_unsupported',
      message: `Restore is not supported for ${driverName(driver) ?? driver}. Nigafiy restores only Juniper Junos devices, which apply a configuration with "commit confirmed" and roll it back by themselves when it is not confirmed. Other vendors have no safe automatic rollback: download the version and restore it by hand.`,
    };
  }
  return null;
}

/** The first reason a restore of this version cannot start now, or null. */
async function blocker(db: Db, t: TargetRow, version: { id: string; sha256: string }): Promise<RestoreBlocker | null> {
  const u = unsupported(t);
  if (u) return u;
  const r = readiness(t);
  if (r !== 'ready') return { code: `backup_${r}`, message: READINESS_ERRORS[r] };
  if (!t.host_key_sha256 || t.host_key_status !== 'pinned') {
    return { code: 'host_key_not_pinned', message: 'Run one successful backup first so the SSH host key of the device is pinned; a restore never trusts an unknown key.' };
  }
  const raw = await db.query(`SELECT 1 FROM config_backup_raw WHERE target_id = $1 AND sha256 = $2`, [t.id, version.sha256]);
  if (!raw.rowCount) {
    return {
      code: 'raw_copy_missing',
      message: 'No restorable copy of this version is stored (stored before restore copies existed, or the copy could not be kept). Only versions backed up since then can be restored.',
    };
  }
  if (t.latest_version_id === version.id) {
    return { code: 'already_current', message: 'This is already the latest backed-up configuration of the device.' };
  }
  const open = await db.query(`SELECT 1 FROM config_backup_restores WHERE target_id = $1 AND status IN ('pre_backup', 'pending')`, [t.id]);
  if (open.rowCount) return { code: 'restore_in_progress', message: 'A restore of this device is already in progress.' };
  if (t.pending_run_id) return { code: 'backup_in_progress', message: 'A backup of this device is running; wait until it finished.' };
  return null;
}

/** The diff from the latest backup to the chosen version, and whether it can be restored. Reads content: admin only, audited. */
export function restorePreview(req: Request, ctx: AuthContext, targetId: string, versionId: string) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStale(db);
    const t = await loadTarget(db, targetId);
    const v = await loadVersion(db, versionId);
    if (v.target_id !== t.id) throw new AppError(422, 'wrong_target', 'The version must belong to this device');
    const current = t.latest_version_id && t.latest_version_id !== v.id ? await loadVersion(db, t.latest_version_id) : null;
    const diff = diffLines(current?.content ?? '', v.content, 3);
    let block = await blocker(db, t, v);
    if (!block && !(await onlineCollector(db, t.site_id))) block = { code: 'no_collector', message: 'No collector of this site is online to reach the device.' };
    await audit(db, req, 'config_backup.restore.preview', { type: 'config_backup_target', id: t.id }, { version: v.number, current: current?.number ?? null });
    const side = (x: { id: string; number: number; captured_at: Date; sha256: string }) => ({ id: x.id, number: x.number, captured_at: x.captured_at, sha256: x.sha256 });
    const driver = effectiveDriver(t);
    return {
      target: { id: t.id, name: t.name, address: t.address },
      version: side(v),
      current: current ? side(current) : null,
      method: driver ? (RESTORE_METHODS[driver] ?? null) : null,
      supported: !unsupported(t),
      possible: !block,
      blocker: block,
      confirm_text: t.name,
      confirm_minutes_default: 5,
      ...diff,
    };
  });
}

export function requestRestore(req: Request, ctx: AuthContext, targetId: string, body: RestoreRequest) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStale(db);
    const t = await loadTarget(db, targetId, true);
    const v = (await db.query<{ id: string; number: number; sha256: string; target_id: string }>(`SELECT id, number, sha256, target_id FROM config_backup_versions WHERE id = $1`, [body.version_id])).rows[0];
    if (!v) throw notFound('Configuration version');
    if (v.target_id !== t.id) throw new AppError(422, 'wrong_target', 'The version must belong to this device');
    const block = await blocker(db, t, v);
    if (block) throw new AppError(409, block.code, block.message);
    if (body.confirm.trim() !== t.name) throw new AppError(422, 'confirm_mismatch', 'Type the device name exactly as shown to confirm the restore');
    const collector = await onlineCollector(db, t.site_id);
    if (!collector) throw new AppError(409, 'no_collector', 'No collector of this site is online to reach the device');
    const method = RESTORE_METHODS[effectiveDriver(t)!]!;
    const restore = (
      await db.query<{ id: string }>(
        `INSERT INTO config_backup_restores (organization_id, site_id, target_id, version_id, version_number, sha256, method, status, reason, confirm_minutes,
                                             collector_id, requested_by, requested_by_email, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pre_backup',$8,$9,$10,$11,$12, now() + make_interval(mins => $13)) RETURNING id`,
        [ctx.organizationId, t.site_id, t.id, v.id, v.number, v.sha256, method, body.reason, body.confirm_minutes, collector.id, ctx.userId, ctx.userEmail, RESTORE_TTL_MINUTES],
      )
    ).rows[0]!;
    const run = await queueRun(db, ctx.organizationId, t, 'restore', collector, { id: ctx.userId, email: ctx.userEmail });
    await db.query(`UPDATE config_backup_restores SET pre_run_id = $2 WHERE id = $1`, [restore.id, run.run_id]);
    await audit(db, req, 'config_backup.restore.request', { type: 'config_backup_target', id: t.id }, {
      restore_id: restore.id,
      version: v.number,
      sha256: v.sha256,
      method,
      reason: body.reason,
      confirm_minutes: body.confirm_minutes,
      pre_run_id: run.run_id,
      collector: collector.name,
    });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return restoreRow(db, restore.id);
  });
}

async function restoreRow(db: Db, id: string) {
  const row = (await db.query(`SELECT ${RESTORE_COLUMNS} FROM config_backup_restores r WHERE r.id = $1`, [id])).rows[0];
  if (!row) throw notFound('Restore');
  return row;
}

export function restoreStatus(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    await expireStale(db);
    return restoreRow(db, id);
  });
}

export function listRestores(organizationId: string, targetId: string) {
  return withTenant(organizationId, async (db) => {
    await expireStale(db);
    await loadTarget(db, targetId);
    const items = (await db.query(`SELECT ${RESTORE_COLUMNS} FROM config_backup_restores r WHERE r.target_id = $1 ORDER BY r.created_at DESC LIMIT 25`, [targetId])).rows;
    return { items };
  });
}

interface OpenRestore {
  id: string;
  organization_id: string;
  site_id: string;
  target_id: string;
  version_id: string;
  version_number: number;
  sha256: string;
  method: string;
  status: string;
  confirm_minutes: number;
  pre_run_id: string | null;
  verify_run_id: string | null;
  command_id: string | null;
  requested_by: string | null;
}

async function finish(
  db: Db,
  c: CollectorContext,
  r: OpenRestore,
  outcome: { status: 'verified' | 'failed' | 'rolled_back'; errorKind?: string | null; error?: string | null; steps?: string[] },
  t: { name: string; device_id: string | null; address: string },
  flags: { committed?: boolean; confirmed?: boolean; rolled_back?: boolean; after_version_id?: string | null } = {},
) {
  await db.query(
    `UPDATE config_backup_restores SET status = $2, error_kind = $3, error = $4, steps = $5, committed = $6, confirmed = $7, rolled_back = $8,
            after_version_id = $9, completed_at = now() WHERE id = $1`,
    [
      r.id,
      outcome.status,
      outcome.errorKind ?? null,
      outcome.error ?? null,
      JSON.stringify(outcome.steps ?? []),
      flags.committed ?? false,
      flags.confirmed ?? false,
      flags.rolled_back ?? false,
      flags.after_version_id ?? null,
    ],
  );
  await auditSystem(db, r.organization_id, {
    automation: 'config_restore',
    action: 'config_backup.restore.result',
    target: { type: 'config_backup_target', id: r.target_id },
    siteId: r.site_id,
    actor: 'collector',
    metadata: {
      restore_id: r.id,
      version: r.version_number,
      status: outcome.status,
      committed: flags.committed ?? false,
      confirmed: flags.confirmed ?? false,
      rolled_back: flags.rolled_back ?? false,
      error_kind: outcome.errorKind ?? null,
    },
  });
  const ok = outcome.status === 'verified';
  await emitEvent(db, r.organization_id, {
    siteId: r.site_id,
    deviceId: t.device_id,
    collectorId: c.id,
    type: ok ? 'config_restored' : 'config_restore_failed',
    // Committed but neither confirmed nor put back: the device's own rollback timer is the last safeguard.
    severity: ok ? 'warning' : flags.committed && !flags.rolled_back && !flags.confirmed ? 'critical' : 'warning',
    title: ok ? `Configuration of "${t.name}" restored to version ${r.version_number}` : `Restore of "${t.name}" to version ${r.version_number} did not complete`,
    details: {
      target_id: r.target_id,
      target_name: t.name,
      address: t.address,
      restore_id: r.id,
      version: r.version_number,
      method: r.method,
      status: outcome.status,
      committed: flags.committed ?? false,
      confirmed: flags.confirmed ?? false,
      rolled_back: flags.rolled_back ?? false,
      error: outcome.error ?? null,
      verified_by: 'the configuration read back over a new SSH session after the commit, compared with the restored version',
    },
    source: 'collector',
    occurredAt: new Date(),
  });
}

/**
 * Called by ingest after a backup result was stored. When the run was the backup before a restore:
 * stop the restore if it failed (nothing was changed), otherwise queue the `config_restore` command.
 */
export async function continueAfterBackup(db: Db, c: CollectorContext, runId: string): Promise<void> {
  const r = (await db.query<OpenRestore>(`SELECT * FROM config_backup_restores WHERE pre_run_id = $1 AND status = 'pre_backup' FOR UPDATE`, [runId])).rows[0];
  if (!r) return;
  const run = (await db.query<{ status: string; error: string | null; version_id: string | null }>(`SELECT status, error, version_id FROM config_backup_runs WHERE id = $1`, [runId])).rows[0]!;
  const t = await loadTarget(db, r.target_id);
  if (run.status !== 'ok') {
    await finish(db, c, r, { status: 'failed', errorKind: 'pre_backup_failed', error: `The backup before the restore failed (${run.error ?? 'no reason given'}). Nothing was changed on the device.` }, t);
    return;
  }
  const current = run.version_id ? (await db.query<{ sha256: string }>(`SELECT sha256 FROM config_backup_versions WHERE id = $1`, [run.version_id])).rows[0] : undefined;
  if (current?.sha256 === r.sha256) {
    await finish(db, c, r, { status: 'verified', steps: ['The backup before the restore shows the device already runs this configuration; nothing was applied.'] }, t, { after_version_id: run.version_id });
    return;
  }
  const block = unsupported(t) ?? (readiness(t) !== 'ready' || t.host_key_status !== 'pinned' ? { code: 'not_ready', message: 'The device or its settings changed during the backup before the restore' } : null);
  if (block) {
    await finish(db, c, r, { status: 'failed', errorKind: block.code, error: `${block.message}. Nothing was changed on the device.` }, t);
    return;
  }
  const verify = (
    await db.query<{ id: string }>(
      `INSERT INTO config_backup_runs (organization_id, site_id, target_id, collector_id, trigger, created_by, expires_at)
       VALUES ($1,$2,$3,$4,'restore',$5, now() + make_interval(mins => $6)) RETURNING id`,
      [r.organization_id, r.site_id, r.target_id, c.id, r.requested_by, RUN_TTL_MINUTES],
    )
  ).rows[0]!;
  const cmd = (
    await db.query<{ id: string }>(
      `INSERT INTO collector_commands (organization_id, collector_id, kind, payload, created_by) VALUES ($1,$2,'config_restore',$3,$4) RETURNING id`,
      [r.organization_id, c.id, JSON.stringify({ restore_id: r.id, target_id: r.target_id }), r.requested_by],
    )
  ).rows[0]!;
  await db.query(
    `UPDATE config_backup_restores SET status = 'pending', verify_run_id = $2, command_id = $3, collector_id = $4,
            expires_at = now() + make_interval(mins => $5) WHERE id = $1`,
    [r.id, verify.id, cmd.id, c.id, RESTORE_COMMAND_TTL_MINUTES],
  );
}

/** config_restore_result: the steps and flags of the restore, checked against the verification read-back. */
export async function processRestoreResult(db: Db, c: CollectorContext, item: ConfigRestoreResultItem): Promise<void> {
  if (item.ok === !!item.error) throw new ItemRejected('config_restore_result: a successful result carries no error, a failed one an error');
  const r = (
    await db.query<OpenRestore>(
      `SELECT * FROM config_backup_restores WHERE id = $1 AND target_id = $2 AND collector_id = $3 AND status IN ('pending', 'expired') AND verify_run_id IS NOT NULL FOR UPDATE`,
      [item.restore_id, item.target_id, c.id],
    )
  ).rows[0];
  if (!r) throw new ItemRejected('config_restore_result for a restore that does not belong to this collector or is already answered');
  const t = await loadTarget(db, r.target_id);
  const verify = (
    await db.query<{ status: string; version_id: string | null; sha256: string | null }>(
      `SELECT r.status, r.version_id, (SELECT v.sha256 FROM config_backup_versions v WHERE v.id = r.version_id) AS sha256 FROM config_backup_runs r WHERE r.id = $1`,
      [r.verify_run_id],
    )
  ).rows[0];
  if (verify && (verify.status === 'pending' || verify.status === 'expired')) {
    await db.query(
      `UPDATE config_backup_runs SET status = 'failed', error_kind = 'command_failed', completed_at = now(),
              error = 'No configuration was read back during the restore' WHERE id = $1`,
      [r.verify_run_id],
    );
  }
  const matches = verify?.status === 'ok' && verify.sha256 === r.sha256;
  let status: 'verified' | 'failed' | 'rolled_back';
  let error = item.error?.message ?? null;
  let errorKind: string | null = item.error?.kind ?? null;
  if (item.ok && matches) status = 'verified';
  else if (item.rolled_back) status = 'rolled_back';
  else {
    status = 'failed';
    if (item.ok) {
      errorKind = 'verify_mismatch';
      error = 'The device reported the restore as applied, but the configuration read back afterwards is not the restored version. Compare the latest versions.';
    }
  }
  if (r.command_id) await db.query(`UPDATE collector_commands SET status = 'completed', completed_at = now() WHERE id = $1 AND status <> 'completed'`, [r.command_id]);
  await finish(db, c, r, { status, errorKind, error, steps: item.steps ?? [] }, t, {
    committed: item.committed,
    confirmed: item.confirmed,
    rolled_back: item.rolled_back,
    after_version_id: verify?.version_id ?? null,
  });
}
