import type { CollectorContext } from '../../common/collector-protocol.ts';
import type { Db } from '../../infrastructure/db.ts';
import { openCredentials } from './credentials.ts';
import { readiness, TARGET_SELECT, type TargetRow } from './service.ts';

interface Command {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * Completes the `config_backup` commands of a heartbeat answer with what the collector needs for that
 * one run: the device address, its SSH credentials (decrypted here and only here), the pinned host
 * key, the vendor choice and what LAN Detective already knows about the device (hints). Stored
 * commands never contain secrets; they are added to the response of the site's own collector over its
 * authenticated channel, for a run that is still pending.
 *
 * A command that can no longer run (target deleted or changed, run expired, credentials removed, host
 * key changed meanwhile) is withdrawn instead: acknowledged here, its run marked failed.
 */
export async function withConfigBackupSecrets(db: Db, c: CollectorContext, commands: Command[]): Promise<Command[]> {
  if (!commands.some((cmd) => cmd.kind === 'config_backup')) return commands;
  const out: Command[] = [];
  for (const cmd of commands) {
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
