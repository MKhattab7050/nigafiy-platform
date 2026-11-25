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
// Only vendors that replace the configuration as a whole and roll it back by themselves are
// supported: Juniper Junos (`commit confirmed`), Cisco IOS XE (`configure replace … revert trigger
// error timer N`, then `configure confirm` and `write memory` only after the read-back matched;
// restore_iosxe.go), VyOS / Ubiquiti EdgeOS (`commit-confirm`, which reboots into the saved
// configuration; the collector saves the running one first) and OpenWrt (rpcd `uci apply` with
// rollback: the changes are staged in a ubus session, rpcd puts the snapshot of the previous packages
// back unless `uci confirm` follows). Every other vendor gets an honest "restore not supported" with
// the vendor-specific reason (UNSUPPORTED_REASONS).
//
// Restoring another device's configuration needs a second, typed confirmation (`allow_other_device`,
// or its alias `force_other_device`, plus `confirm_other_device`). Two checks decide it:
//   - the hardware identity (model / serial, read by the collector next to every backup of Junos,
//     VyOS / EdgeOS and OpenWrt; IDENTITY_DRIVERS) of the version against the device's, compared at
//     preview, at request, after the backup before the restore, and by the collector on the device;
//     a different or unknown device needs the confirmation (typed: the device's serial, model or
//     address);
//   - the host name the configuration declares (IOS `hostname`, Junos `host-name`) of the version
//     against the latest backup; another host name needs the confirmation (typed: the version's host
//     name) when the hardware identity does not already require it.

/** Driver → restore method. Must match the collector (internal/configbackup/restore.go). */
export const RESTORE_METHODS: Readonly<Record<string, string>> = {
  juniper_junos: 'junos_commit_confirmed',
  cisco_ios: 'iosxe_configure_replace',
  vyos_edgeos: 'vyos_commit_confirm',
  openwrt: 'openwrt_uci_apply_rollback',
};

/** Drivers whose backups record the device's hardware identity (collector identity.go). */
export const IDENTITY_DRIVERS: ReadonlySet<string> = new Set(['juniper_junos', 'vyos_edgeos', 'openwrt']);

/**
 * Why each other driver cannot be restored safely (the web shows the same reasons in EN and AR).
 * Cisco IOS XE is restorable (restore_iosxe.go) and has no entry here.
 */
export const UNSUPPORTED_REASONS: Readonly<Record<string, string>> = {
  cisco_nxos:
    'NX-OS replaces a configuration as a whole only with "configure replace bootflash:<file> commit-timeout" (NX-OS 9.3(1) and later), which needs the file copied to bootflash first. The Nigafiy collector does not transfer files to devices, and lines pasted into the CLI merge into the running configuration without a rollback timer.',
  cisco_asa:
    'Cisco ASA has no commit-confirmed and no automatic rollback: pasted lines and "copy … running-config" merge into the running configuration, and a full replace means erasing the configuration and reloading.',
  aruba_procurve:
    'ArubaOS-Switch applies every CLI line at once (no candidate configuration, no rollback timer); replacing the whole configuration needs a file uploaded by TFTP / SFTP and a reboot.',
  aruba_aoscx:
    'AOS-CX can roll back by itself ("checkpoint auto"), but pasted CLI lines merge into the running configuration; replacing it as a whole needs "copy <checkpoint or file> running-config" from a file on the switch or a TFTP / SFTP server, which the Nigafiy collector does not transfer.',
  mikrotik_routeros:
    'RouterOS has no atomic replace with a rollback timer: an /export script merges into the running configuration when imported ("/import … dry-run" in RouterOS 7 only simulates it), a full replace needs "/system reset-configuration run-after-reset=" with a reboot and no automatic way back, and Safe Mode undoes changes only when the session drops (after a TCP timeout of about 9 minutes) and keeps just the 100 most recent actions: a larger change leaves Safe Mode without undoing anything.',
  fortinet_fortios:
    'FortiOS replaces the whole configuration only with "execute restore config" or the REST restore (monitor system/config/restore), which reboot into the restored file and save it, so nothing is left to revert to; its revert mode ("set cfg-save revert" with "cfg-revert-timeout") undoes only unsaved CLI edits, and pasted "show" output merges (objects added since the backup stay) instead of replacing.',
  huawei_vrp:
    'Huawei VRP V8 can try a configuration with "commit trial" and replace it with "configuration replace file", but only from a file on the device’s flash copied there by SFTP / FTP, which the Nigafiy collector does not transfer; VRP V5 has neither. Pasted lines merge without a rollback timer.',
  dell_os10:
    'Dell OS10 replaces the running configuration only from a file ("copy <file> running-configuration") on a server or in the switch’s home directory, which the Nigafiy collector does not transfer, and documents no automatic rollback timer.',
  dell_os6:
    'Dell OS6 applies every CLI line at once; replacing the configuration needs a file copied to the startup configuration and a reload, without an automatic rollback.',
  paloalto_panos:
    'PAN-OS loads a full configuration only from a saved file ("load config from") imported by SCP / TFTP, and its commit has no confirmed mode or automatic rollback timer.',
};

/** The host name a configuration declares (IOS `hostname X`, Junos `host-name X;`), or null. */
export function configHostname(text: string): string | null {
  const m = /^hostname\s+(\S+)\s*$/m.exec(text) ?? /^\s*host-name\s+"?([^";\s]+)"?;\s*$/m.exec(text);
  return m?.[1] ?? null;
}

/** Both host names when the version names another device than the latest backup does, else null. */
function otherDevice(current: string | null | undefined, version: string): { current: string; version: string } | null {
  if (!current) return null;
  const a = configHostname(current);
  const b = configHostname(version);
  return a && b && a !== b ? { current: a, version: b } : null;
}

const effectiveDriver = (t: TargetRow) => t.driver ?? t.detected_driver;
const driverName = (id: string | null) => CONFIG_BACKUP_DRIVERS.find((d) => d.id === id)?.name ?? null;

export interface RestoreBlocker {
  code: string;
  message: string;
}

const RESTORE_COLUMNS = `r.id, r.target_id, r.version_id, r.version_number, r.sha256, r.method, r.status, r.reason, r.confirm_minutes, r.pre_run_id,
  r.verify_run_id, r.after_version_id, r.committed, r.confirmed, r.rolled_back, r.steps, r.error_kind, r.error, r.requested_by_email,
  r.created_at, r.expires_at, r.completed_at, r.forced_other_device, r.identity_check, r.device_model, r.device_serial, (SELECT c.name FROM collectors c WHERE c.id = r.collector_id) AS collector_name`;

function unsupported(t: TargetRow): RestoreBlocker | null {
  const driver = effectiveDriver(t);
  if (!driver) {
    return {
      code: 'restore_vendor_unknown',
      message: 'The vendor of this device is not known yet. Run a backup or choose the vendor first; restore is only offered for vendors with an automatic rollback.',
    };
  }
  if (!RESTORE_METHODS[driver]) {
    const why = UNSUPPORTED_REASONS[driver] ?? 'This vendor has no safe way to replace the configuration as a whole with an automatic rollback.';
    return {
      code: 'restore_unsupported',
      message: `Restore is not supported for ${driverName(driver) ?? driver}. ${why} Nigafiy restores only Juniper Junos ("commit confirmed"), Cisco IOS XE ("configure replace" with a rollback timer), VyOS / EdgeOS ("commit-confirm") and OpenWrt (rpcd "uci apply" with rollback), which roll back by themselves when the restore is not confirmed. Download the version and restore it by hand.`,
    };
  }
  return null;
}

export interface Identity {
  model: string | null;
  serial: string | null;
}
export type IdentityCheck = 'match' | 'mismatch' | 'unknown';

const same = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The version's identity against the device's: a field both sides know that differs is a mismatch. */
export function compareIdentity(version: Identity, device: Identity): IdentityCheck {
  if (version.serial && device.serial && !same(version.serial, device.serial)) return 'mismatch';
  if (version.model && device.model && !same(version.model, device.model)) return 'mismatch';
  if (same(version.serial, device.serial) || same(version.model, device.model)) return 'match';
  return 'unknown';
}

async function versionIdentity(db: Db, versionId: string): Promise<Identity> {
  const r = (await db.query<{ device_model: string | null; device_serial: string | null }>(`SELECT device_model, device_serial FROM config_backup_versions WHERE id = $1`, [versionId])).rows[0];
  return { model: r?.device_model ?? null, serial: r?.device_serial ?? null };
}

/** The identity the device reported in its latest successful backup. */
async function deviceIdentity(db: Db, targetId: string, runId?: string): Promise<Identity> {
  const r = (
    await db.query<{ device_model: string | null; device_serial: string | null }>(
      runId
        ? `SELECT device_model, device_serial FROM config_backup_runs WHERE id = $2 AND target_id = $1`
        : `SELECT device_model, device_serial FROM config_backup_runs WHERE target_id = $1 AND status = 'ok' ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
      runId ? [targetId, runId] : [targetId],
    )
  ).rows[0];
  return { model: r?.device_model ?? null, serial: r?.device_serial ?? null };
}

/** The text an administrator types to restore onto a different or unidentified device. */
const otherDeviceConfirmText = (t: TargetRow, device: Identity) => device.serial ?? device.model ?? t.address;

const IDENTITY_BLOCKS: Record<Exclude<IdentityCheck, 'match'>, RestoreBlocker> = {
  mismatch: {
    code: 'device_identity_mismatch',
    message: 'This version was taken from a different device (the model or serial number recorded with it differs from the device now). Confirm restoring onto this device explicitly to continue.',
  },
  unknown: {
    code: 'device_identity_unknown',
    message: 'Nigafiy cannot tell whether this version was taken from this device (no model or serial number was recorded with the version or reported by the device). Confirm restoring onto this device explicitly to continue.',
  },
};

/** Whether restoring needs the second confirmation, why, and the text to type; null when not. */
function otherDeviceNeed(
  t: TargetRow,
  check: IdentityCheck,
  device: Identity,
  other: { current: string; version: string } | null,
): { block: RestoreBlocker; confirmText: string; mismatch: string } | null {
  const driver = effectiveDriver(t);
  if (driver && IDENTITY_DRIVERS.has(driver) && check !== 'match') {
    return { block: IDENTITY_BLOCKS[check], confirmText: otherDeviceConfirmText(t, device), mismatch: 'Type the device identifier exactly as shown to confirm restoring onto this device' };
  }
  if (other) {
    return {
      block: {
        code: 'other_device',
        message: `This version is the configuration of "${other.version}", but the device is now "${other.current}". Restore it only if that is intended: force it and type "${other.version}" as the second confirmation.`,
      },
      confirmText: other.version,
      mismatch: `Type the host name of the version ("${other.version}") exactly to confirm restoring another device's configuration`,
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
    const vid = await versionIdentity(db, v.id);
    const did = await deviceIdentity(db, t.id);
    const check = compareIdentity(vid, did);
    const other = otherDevice(current?.content, v.content);
    const need = otherDeviceNeed(t, check, did, other);
    await audit(db, req, 'config_backup.restore.preview', { type: 'config_backup_target', id: t.id }, { version: v.number, current: current?.number ?? null, identity_check: check });
    const side = (x: { id: string; number: number; captured_at: Date; sha256: string }) => ({ id: x.id, number: x.number, captured_at: x.captured_at, sha256: x.sha256 });
    const driver = effectiveDriver(t);
    return {
      target: { id: t.id, name: t.name, address: t.address },
      version: side(v),
      current: current ? side(current) : null,
      driver: driver ?? null,
      method: driver ? (RESTORE_METHODS[driver] ?? null) : null,
      supported: !unsupported(t),
      identity: { version: vid, device: did, check },
      // Set when restoring needs the second, typed confirmation (another or an unidentified device).
      other_device_block: need?.block ?? null,
      other_device_confirm_text: need?.confirmText ?? null,
      possible: !block,
      blocker: block,
      confirm_text: t.name,
      confirm_minutes_default: 5,
      other_device: other,
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
    const did = await deviceIdentity(db, t.id);
    const check = compareIdentity(await versionIdentity(db, v.id), did);
    const versionText = (await loadVersion(db, v.id)).content;
    const other = otherDevice(t.latest_version_id ? (await loadVersion(db, t.latest_version_id)).content : null, versionText);
    const need = otherDeviceNeed(t, check, did, other);
    if (need) {
      if (!body.allow_other_device && !body.force_other_device) throw new AppError(409, need.block.code, need.block.message);
      if ((body.confirm_other_device ?? '').trim() !== need.confirmText) throw new AppError(422, 'confirm_other_device_mismatch', need.mismatch);
    }
    const forced = !!need;
    const collector = await onlineCollector(db, t.site_id);
    if (!collector) throw new AppError(409, 'no_collector', 'No collector of this site is online to reach the device');
    const method = RESTORE_METHODS[effectiveDriver(t)!]!;
    const restore = (
      await db.query<{ id: string }>(
        `INSERT INTO config_backup_restores (organization_id, site_id, target_id, version_id, version_number, sha256, method, status, reason, confirm_minutes,
                                             collector_id, requested_by, requested_by_email, expires_at, forced_other_device, identity_check)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pre_backup',$8,$9,$10,$11,$12, now() + make_interval(mins => $13), $14, $15) RETURNING id`,
        [ctx.organizationId, t.site_id, t.id, v.id, v.number, v.sha256, method, body.reason, body.confirm_minutes, collector.id, ctx.userId, ctx.userEmail, RESTORE_TTL_MINUTES, forced, check],
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
      other_device: other,
      pre_run_id: run.run_id,
      collector: collector.name,
      identity_check: check,
      forced_other_device: forced,
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
  forced_other_device: boolean;
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
      forced_other_device: r.forced_other_device,
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
  // The device as it answered the backup just now, against the version: a device swapped in meanwhile
  // (or one never identified) is refused unless the administrator forced it.
  const check = compareIdentity(await versionIdentity(db, r.version_id), await deviceIdentity(db, r.target_id, runId));
  await db.query(`UPDATE config_backup_restores SET identity_check = $2 WHERE id = $1`, [r.id, check]);
  if (IDENTITY_DRIVERS.has(effectiveDriver(t) ?? '') && check !== 'match' && !r.forced_other_device) {
    await finish(db, c, r, { status: 'failed', errorKind: 'device_mismatch', error: `${IDENTITY_BLOCKS[check].message} Nothing was changed on the device.` }, t);
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
  if (item.device_identity) {
    await db.query(`UPDATE config_backup_restores SET device_model = $2, device_serial = $3 WHERE id = $1`, [r.id, item.device_identity.model ?? null, item.device_identity.serial ?? null]);
  }
  if (r.command_id) await db.query(`UPDATE collector_commands SET status = 'completed', completed_at = now() WHERE id = $1 AND status <> 'completed'`, [r.command_id]);
  await finish(db, c, r, { status, errorKind, error, steps: item.steps ?? [] }, t, {
    committed: item.committed,
    confirmed: item.confirmed,
    rolled_back: item.rolled_back,
    after_version_id: verify?.version_id ?? null,
  });
}
