import { gunzipSync } from 'node:zlib';
import { auditSystem } from '../../common/audit.ts';
import { type CollectorContext, type ConfigBackupProbeResultItem, type ConfigBackupResultItem, ItemRejected } from '../../common/collector-protocol.ts';
import { decryptSecret, encryptSecret } from '../../common/crypto.ts';
import type { Db } from '../../infrastructure/db.ts';
import { emitEvent } from '../events/index.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { diffLines } from './diff.ts';
import { normalizeConfig } from './normalize.ts';
import { MAX_CONFIG_BYTES } from './schema.ts';

// Applies config_backup_result and config_backup_probe_result telemetry. Runs inside the telemetry
// batch's per-item savepoint: an item refused here (ItemRejected) changes nothing.

interface Target {
  id: string;
  site_id: string;
  device_id: string | null;
  name: string;
  address: string;
  host_key_sha256: string | null;
  host_key_status: 'none' | 'pinned' | 'changed';
  last_status: 'never' | 'ok' | 'failed';
  last_error_kind: string | null;
}

export async function processConfigBackupItem(db: Db, c: CollectorContext, item: ConfigBackupResultItem | ConfigBackupProbeResultItem): Promise<void> {
  if (item.type === 'config_backup_probe_result') await processProbeResult(db, c, item);
  else await processBackupResult(db, c, item);
  await notifyRealtime(db, c.organizationId, 'devices');
}

function decodeConfig(b64: string): string {
  let raw: Buffer;
  try {
    raw = gunzipSync(Buffer.from(b64, 'base64'), { maxOutputLength: MAX_CONFIG_BYTES });
  } catch {
    throw new ItemRejected('config_backup_result: the configuration is not valid gzip data or exceeds the size limit');
  }
  const text = raw.toString('utf8');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new ItemRejected('config_backup_result: the configuration contains control characters');
  return text;
}

async function processBackupResult(db: Db, c: CollectorContext, item: ConfigBackupResultItem): Promise<void> {
  if (item.ok ? !item.config_gzip_b64 || !!item.error : !item.error) {
    throw new ItemRejected('config_backup_result: a successful result carries the configuration, a failed one an error');
  }
  const run = (
    await db.query<{ id: string; trigger: string }>(
      `SELECT id, trigger FROM config_backup_runs WHERE id = $1 AND target_id = $2 AND collector_id = $3 AND status IN ('pending', 'expired') FOR UPDATE`,
      [item.run_id, item.target_id, c.id],
    )
  ).rows[0];
  if (!run) throw new ItemRejected('config_backup_result for a run that does not belong to this collector or is already answered');
  const t = (
    await db.query<Target>(
      `SELECT id, site_id, device_id, name, host(address) AS address, host_key_sha256, host_key_status, last_status, last_error_kind
         FROM config_backup_targets WHERE id = $1 AND site_id = $2 FOR UPDATE`,
      [item.target_id, c.siteId],
    )
  ).rows[0];
  if (!t) throw new ItemRejected('config_backup_result for a device that is not configured for this collector’s site');
  const at = new Date(item.ts);
  const sets: string[] = ['last_run_at = greatest(coalesce(last_run_at, $2), $2)', 'updated_at = now()'];
  const vals: unknown[] = [t.id, at];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };

  // ── SSH host key: trust on first use, explicit alert on change ──
  const presented = item.host_key;
  let keyChanged = item.error?.kind === 'host_key_changed' || item.host_key_status === 'changed';
  if (presented && t.host_key_sha256 && presented.sha256 !== t.host_key_sha256) keyChanged = true;
  if (keyChanged) {
    set('host_key_status', 'changed');
    set('presented_host_key', JSON.stringify(presented ? { sha256: presented.sha256, type: presented.type, seen_at: at.toISOString() } : { sha256: null, type: null, seen_at: at.toISOString() }));
    if (t.host_key_status !== 'changed') {
      await emitEvent(db, c.organizationId, {
        siteId: t.site_id,
        deviceId: t.device_id,
        collectorId: c.id,
        type: 'config_host_key_changed',
        severity: 'critical',
        title: `SSH host key of "${t.name}" changed — configuration backups stopped`,
        details: {
          target_id: t.id,
          address: t.address,
          pinned: t.host_key_sha256,
          presented: presented?.sha256 ?? null,
          presented_type: presented?.type ?? null,
          credentials_sent: false,
          note: 'The collector stopped during the SSH key exchange, before any credential was sent. A replaced or re-imaged device explains this; otherwise something may be impersonating it. Accept the new key in Configuration backup only after checking.',
        },
        source: 'collector',
        occurredAt: at,
      });
    }
  } else if (presented && !t.host_key_sha256) {
    set('host_key_sha256', presented.sha256);
    set('host_key_type', presented.type);
    set('host_key_pinned_at', at);
    sets.push(`host_key_pinned_via = 'first_use'`, `host_key_status = 'pinned'`);
    await auditSystem(db, c.organizationId, {
      automation: 'config_backup_host_key_first_use',
      action: 'config_backup.host_key.pin_first_use',
      target: { type: 'config_backup_target', id: t.id },
      siteId: t.site_id,
      actor: 'collector',
      metadata: { sha256: presented.sha256, key_type: presented.type, address: t.address },
    });
  }

  if (item.server_version) set('server_version', item.server_version);
  if (item.detection?.driver) {
    set('detected_driver', item.detection.driver);
    set('detection', JSON.stringify(item.detection));
  }

  let outcome: 'first' | 'changed' | 'unchanged' | null = null;
  let versionId: string | null = null;
  let errorKind = item.error?.kind ?? null;
  let errorText = item.error?.message ?? null;

  if (item.ok) {
    const norm = normalizeConfig(decodeConfig(item.config_gzip_b64!));
    if (norm.lineCount === 0) {
      errorKind = 'empty_config';
      errorText = 'The device returned an empty configuration';
    } else {
      const latest = (
        await db.query<{ id: string; number: number; sha256: string; content_enc: string }>(
          `SELECT v.id, v.number, v.sha256, c.content_enc FROM config_backup_versions v
             JOIN config_backup_contents c ON c.target_id = v.target_id AND c.sha256 = v.sha256
            WHERE v.target_id = $1 ORDER BY v.number DESC LIMIT 1`,
          [t.id],
        )
      ).rows[0];
      if (latest && latest.sha256 === norm.sha256) {
        outcome = 'unchanged';
        versionId = latest.id;
        await db.query(`UPDATE config_backup_versions SET last_seen_at = greatest(last_seen_at, $2), confirmations = confirmations + 1 WHERE id = $1`, [latest.id, at]);
      } else {
        await db.query(
          `INSERT INTO config_backup_contents (target_id, sha256, organization_id, content_enc, size_bytes, line_count)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [t.id, norm.sha256, c.organizationId, encryptSecret(norm.text), norm.sizeBytes, norm.lineCount],
        );
        let added = norm.lineCount;
        let removed = 0;
        let previousText: string | null = null;
        if (latest) {
          try {
            previousText = decryptSecret(latest.content_enc);
          } catch {
            previousText = null;
          }
          if (previousText !== null) {
            const d = diffLines(previousText, norm.text, 0);
            added = d.added;
            removed = d.removed;
          }
        }
        versionId = (
          await db.query<{ id: string }>(
            `INSERT INTO config_backup_versions (organization_id, target_id, number, sha256, captured_at, last_seen_at, run_id, collector_id, driver, added_lines, removed_lines)
             VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [c.organizationId, t.id, (latest?.number ?? 0) + 1, norm.sha256, at, run.id, c.id, item.detection?.driver || null, latest ? added : 0, latest ? removed : 0],
          )
        ).rows[0]!.id;
        outcome = latest ? 'changed' : 'first';
        set('last_changed_at', at);
        if (latest) {
          await emitEvent(db, c.organizationId, {
            siteId: t.site_id,
            deviceId: t.device_id,
            collectorId: c.id,
            type: 'config_changed',
            severity: 'warning',
            title: `Configuration of "${t.name}" changed (+${added} / −${removed} lines)`,
            details: {
              target_id: t.id,
              address: t.address,
              from_version: latest.number,
              to_version: latest.number + 1,
              from_version_id: latest.id,
              to_version_id: versionId,
              added_lines: added,
              removed_lines: removed,
              detected_by: 'scheduled or manual backup comparing the normalized running configuration with the previous version',
              trigger: run.trigger,
            },
            source: 'collector',
            occurredAt: at,
          });
        }
      }
    }
  }

  const ok = item.ok && !!versionId;
  if (ok) {
    set('last_success_at', at);
    sets.push(`last_status = 'ok'`, 'last_error = NULL', 'last_error_kind = NULL', 'credentials_rejected = false');
  } else {
    sets.push(`last_status = 'failed'`);
    set('last_error', errorText);
    set('last_error_kind', errorKind);
    // Rejected credentials: no further login until the administrator replaces them (no account lock-out).
    if (errorKind === 'auth_failed') sets.push('credentials_rejected = true');
    // Once per problem: when backups start failing, or fail for a different reason than before.
    if ((t.last_status !== 'failed' || t.last_error_kind !== errorKind) && errorKind !== 'host_key_changed') {
      await emitEvent(db, c.organizationId, {
        siteId: t.site_id,
        deviceId: t.device_id,
        collectorId: c.id,
        type: 'config_backup_failed',
        severity: 'warning',
        title: `Configuration backup of "${t.name}" failed`,
        details: { target_id: t.id, address: t.address, error_kind: errorKind, error: errorText, trigger: run.trigger },
        source: 'collector',
        occurredAt: at,
      });
    }
  }
  await db.query(`UPDATE config_backup_targets SET ${sets.join(', ')} WHERE id = $1`, vals);
  await db.query(
    `UPDATE config_backup_runs SET status = $2, outcome = $3, version_id = $4, host_key_status = $5, error_kind = $6, error = $7, duration_ms = $8, completed_at = $9
      WHERE id = $1`,
    [run.id, ok ? 'ok' : 'failed', outcome, versionId, item.host_key_status ?? null, ok ? null : errorKind, ok ? null : errorText, item.duration_ms ?? null, at],
  );
}

async function processProbeResult(db: Db, c: CollectorContext, item: ConfigBackupProbeResultItem): Promise<void> {
  const run = (
    await db.query<{ id: string; site_id: string }>(
      `SELECT id, site_id FROM config_backup_probe_runs WHERE id = $1 AND collector_id = $2 AND site_id = $3 AND status IN ('pending', 'expired') FOR UPDATE`,
      [item.run_id, c.id, c.siteId],
    )
  ).rows[0];
  if (!run) throw new ItemRejected('config_backup_probe_result for a check that does not belong to this collector or is already answered');
  const at = new Date(item.ts);
  let open = 0;
  for (const r of item.results) {
    // Only addresses inside an authorized scope of the site are recorded.
    const inScope = await db.query(`SELECT 1 FROM network_scopes WHERE site_id = $1 AND enabled AND $2::inet <<= cidr`, [c.siteId, r.address]);
    if (!inScope.rowCount) continue;
    if (r.open) open++;
    await db.query(
      `INSERT INTO config_backup_probes (site_id, address, port, organization_id, open, server_version, error, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (site_id, address, port) DO UPDATE SET open = EXCLUDED.open, server_version = EXCLUDED.server_version, error = EXCLUDED.error, checked_at = EXCLUDED.checked_at
        WHERE config_backup_probes.checked_at <= EXCLUDED.checked_at`,
      [c.siteId, r.address, r.port, c.organizationId, r.open, r.server_version ?? null, r.error ?? null, at],
    );
  }
  await db.query(`UPDATE config_backup_probe_runs SET status = 'done', open_count = $2, completed_at = $3 WHERE id = $1`, [run.id, open, at]);
}
