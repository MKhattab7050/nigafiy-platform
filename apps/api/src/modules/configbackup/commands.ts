import { gzipSync } from 'node:zlib';
import { auditSystem } from '../../common/audit.ts';
import type { CollectorContext } from '../../common/collector-protocol.ts';
import { decryptSecret } from '../../common/crypto.ts';
import type { Db } from '../../infrastructure/db.ts';
import { openCredentials } from './credentials.ts';
import { RESTORE_METHODS } from './restore.ts';
import { readiness, TARGET_SELECT, type TargetRow } from './service.ts';

interface Command {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * Completes the `config_backup` commands of a heartbeat answer with what the collector needs for that
 * one run: the device address, its SSH credentials (decrypted here and only here), the pinned host
 * key, the vendor choice and what Nigafiy already knows about the device (hints). Stored
 * commands never contain secrets; they are added to the response of the site's own collector over its
 * authenticated channel, for a run that is still pending.
 *
 * A command that can no longer run (target deleted or changed, run expired, credentials removed, host
 * key changed meanwhile) is withdrawn instead: acknowledged here, its run marked failed.
 */
export async function withConfigBackupSecrets(db: Db, c: CollectorContext, commands: Command[]): Promise<Command[]> {
  if (!commands.some((cmd) => cmd.kind === 'config_backup' || cmd.kind === 'config_restore')) return commands;
  const out: Command[] = [];
  for (const cmd of commands) {
    if (cmd.kind === 'config_restore') {
      const full = await withRestoreSecrets(db, c, cmd);
      if (full) out.push(full);
      continue;
    }
    if (cmd.kind !== 'config_backup') {
      out.push(cmd);
      continue;
    }
    const runId = typeof cmd.payload.run_id === 'string' ? cmd.payload.run_id : '';
    const run = (
      await db.query<{ id: string; target_id: string; expires_at: Date }>(
        `SELECT id, target_id, expires_at FROM config_backup_runs WHERE id::text = $1 AND collector_id = $2 AND status = 'pending'`,
        [runId, c.id],
      )
    ).rows[0];
    const t = run ? (await db.query<TargetRow>(`${TARGET_SELECT} WHERE t.id = $1 AND t.site_id = $2`, [run.target_id, c.siteId])).rows[0] : undefined;
    const creds = t ? openCredentials(t.secret_enc) : null;
    const ready = t ? readiness(t) : null;
    // Includes credentials the device rejected since the run was queued: no second failed login.
    if (!run || !t || !creds || ready !== 'ready') {
      await db.query(`UPDATE collector_commands SET status = 'completed', completed_at = now() WHERE id = $1`, [cmd.id]);
      if (run) {
        await db.query(
          `UPDATE config_backup_runs SET status = 'failed', error_kind = 'invalid_argument', completed_at = now(),
                  error = 'The backup was withdrawn before the collector started it: the device or its settings changed'
            WHERE id = $1 AND status = 'pending'`,
          [run.id],
        );
      }
      continue;
    }
    const hints = (
      await db.query<{ oui_vendor: string | null; sys_descr: string | null }>(
        `SELECT (SELECT vendor FROM devices WHERE id = $1) AS oui_vendor,
                (SELECT sys_descr FROM snmp_targets WHERE site_id = $2 AND host = $3::inet LIMIT 1) AS sys_descr`,
        [t.device_id, t.site_id, t.address],
      )
    ).rows[0]!;
    out.push({
      ...cmd,
      payload: {
        run_id: run.id,
        target_id: t.id,
        address: t.address,
        port: t.port,
        username: creds.username,
        ...(creds.password ? { password: creds.password } : {}),
        ...(creds.private_key ? { private_key: creds.private_key } : {}),
        ...(creds.passphrase ? { passphrase: creds.passphrase } : {}),
        ...(creds.enable_secret ? { enable_secret: creds.enable_secret } : {}),
        ...(t.host_key_sha256 ? { host_key_sha256: t.host_key_sha256, host_key_type: t.host_key_type } : {}),
        ...(t.driver ? { driver: t.driver } : {}),
        hints: {
          ...(t.detected_driver ? { driver: t.detected_driver } : {}),
          ...(hints.oui_vendor ? { oui_vendor: hints.oui_vendor } : {}),
          ...(hints.sys_descr ? { sys_descr: hints.sys_descr } : {}),
        },
        expires_at: run.expires_at.toISOString(),
      },
    });
  }
  return out;
}

const credentialFields = (creds: NonNullable<ReturnType<typeof openCredentials>>) => ({
  username: creds.username,
  ...(creds.password ? { password: creds.password } : {}),
  ...(creds.private_key ? { private_key: creds.private_key } : {}),
  ...(creds.passphrase ? { passphrase: creds.passphrase } : {}),
  ...(creds.enable_secret ? { enable_secret: creds.enable_secret } : {}),
});

/**
 * A pending `config_restore` command (restore.ts): the credentials, the pinned host key and the
 * version's sealed raw configuration, decrypted here for the site's own collector only. Withdrawn
 * (restore failed, nothing changed) when anything needed is gone or no longer safe.
 */
async function withRestoreSecrets(db: Db, c: CollectorContext, cmd: Command): Promise<Command | null> {
  const restoreId = typeof cmd.payload.restore_id === 'string' ? cmd.payload.restore_id : '';
  const r = (
    await db.query<{ id: string; target_id: string; sha256: string; verify_run_id: string | null; confirm_minutes: number; expires_at: Date }>(
      `SELECT id, target_id, sha256, verify_run_id, confirm_minutes, expires_at FROM config_backup_restores
        WHERE id::text = $1 AND collector_id = $2 AND status = 'pending' AND expires_at > now()`,
      [restoreId, c.id],
    )
  ).rows[0];
  const t = r ? (await db.query<TargetRow>(`${TARGET_SELECT} WHERE t.id = $1 AND t.site_id = $2`, [r.target_id, c.siteId])).rows[0] : undefined;
  const creds = t ? openCredentials(t.secret_enc) : null;
  const driver = t ? (t.driver ?? t.detected_driver) : null;
  let config: string | null = null;
  if (r && t) {
    const raw = (await db.query<{ raw_enc: string }>(`SELECT raw_enc FROM config_backup_raw WHERE target_id = $1 AND sha256 = $2`, [t.id, r.sha256])).rows[0];
    try {
      config = raw ? decryptSecret(raw.raw_enc) : null;
    } catch {
      config = null;
    }
  }
  if (!r || !t || !creds || readiness(t) !== 'ready' || t.host_key_status !== 'pinned' || !t.host_key_sha256 || !driver || !RESTORE_METHODS[driver] || !config || !r.verify_run_id) {
    await db.query(`UPDATE collector_commands SET status = 'completed', completed_at = now() WHERE id = $1`, [cmd.id]);
    if (r) {
      await db.query(
        `UPDATE config_backup_restores SET status = 'failed', error_kind = 'withdrawn', completed_at = now(),
                error = 'The restore was withdrawn before the collector started it: the device, its credentials, its host key or the stored copy changed. Nothing was changed on the device.'
          WHERE id = $1 AND status = 'pending'`,
        [r.id],
      );
      await db.query(`UPDATE config_backup_runs SET status = 'failed', error_kind = 'invalid_argument', completed_at = now(), error = 'The restore was withdrawn' WHERE id = $1 AND status = 'pending'`, [
        r.verify_run_id,
      ]);
      await auditSystem(db, c.organizationId, {
        automation: 'config_restore',
        action: 'config_backup.restore.withdrawn',
        target: { type: 'config_backup_target', id: r.target_id },
        siteId: c.siteId,
        metadata: { restore_id: r.id },
      });
    }
    return null;
  }
  return {
    ...cmd,
    payload: {
      restore_id: r.id,
      verify_run_id: r.verify_run_id,
      target_id: t.id,
      address: t.address,
      port: t.port,
      ...credentialFields(creds),
      host_key_sha256: t.host_key_sha256,
      host_key_type: t.host_key_type,
      driver,
      config_gzip_b64: gzipSync(Buffer.from(config, 'utf8')).toString('base64'),
      confirm_minutes: r.confirm_minutes,
      expires_at: r.expires_at.toISOString(),
    },
  };
}
