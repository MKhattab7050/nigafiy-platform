import type { Request } from 'express';
import { audit } from '../../common/audit.ts';
import { CONFIG_BACKUP_DRIVERS } from '../../common/config-backup-protocol.ts';
import { decryptSecret } from '../../common/crypto.ts';
import { AppError, type AuthContext, notFound } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { notifyRealtime } from '../realtime/index.ts';
import { describeCredentials, openCredentials, sealCredentials } from './credentials.ts';
import { suggestDriver } from './detect.ts';
import { diffLines, unifiedText } from './diff.ts';
import { fingerprintKey, prepareConfig } from './resanitize.ts';
import { nextDailyRun } from './schedule.ts';
import {
  type Credentials,
  MAX_PROBE_ADDRESSES,
  MAX_TARGETS_PER_SITE,
  PROBE_TTL_MINUTES,
  RUN_TTL_MINUTES,
  type TargetPatch,
  type TargetsCreate,
} from './schema.ts';

// Configuration backup: targets, runs, versions, diffs and SSH reachability checks. Every write is
// audited; credentials are never returned, logged or audited (only "credentials set / changed").
// Reading a configuration's content (view, diff, download) is restricted to administrators and
// audited too: a configuration carries password hashes and SNMP communities.

export interface TargetRow {
  id: string;
  site_id: string;
  device_id: string | null;
  name: string;
  address: string;
  port: number;
  driver: string | null;
  detected_driver: string | null;
  detection: Record<string, unknown> | null;
  server_version: string | null;
  secret_enc: string | null;
  credentials_updated_at: Date | null;
  credentials_rejected: boolean;
  host_key_sha256: string | null;
  host_key_type: string | null;
  host_key_pinned_at: Date | null;
  host_key_pinned_via: 'first_use' | 'admin' | null;
  host_key_status: 'none' | 'pinned' | 'changed';
  presented_host_key: { sha256: string; type: string; seen_at: string } | null;
  enabled: boolean;
  schedule: 'daily' | 'off';
  schedule_hour: number;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_success_at: Date | null;
  last_changed_at: Date | null;
  last_status: 'never' | 'ok' | 'failed';
  last_error: string | null;
  last_error_kind: string | null;
  created_at: Date;
  updated_at: Date;
  in_scope: boolean;
  version_count: number;
  latest_version_id: string | null;
  pending_run_id: string | null;
  device_label: string | null;
  site_timezone: string;
}

export const TARGET_SELECT = `
  SELECT t.id, t.site_id, t.device_id, t.name, host(t.address) AS address, t.port, t.driver, t.detected_driver, t.detection, t.server_version,
         t.secret_enc, t.credentials_updated_at, t.credentials_rejected, t.host_key_sha256, t.host_key_type, t.host_key_pinned_at, t.host_key_pinned_via,
         t.host_key_status, t.presented_host_key, t.enabled, t.schedule, t.schedule_hour, t.next_run_at, t.last_run_at, t.last_success_at,
         t.last_changed_at, t.last_status, t.last_error, t.last_error_kind, t.created_at, t.updated_at,
         EXISTS (SELECT 1 FROM network_scopes s WHERE s.site_id = t.site_id AND s.enabled AND t.address <<= s.cidr) AS in_scope,
         (SELECT count(*)::int FROM config_backup_versions v WHERE v.target_id = t.id) AS version_count,
         (SELECT v.id FROM config_backup_versions v WHERE v.target_id = t.id ORDER BY v.number DESC LIMIT 1) AS latest_version_id,
         (SELECT r.id FROM config_backup_runs r WHERE r.target_id = t.id AND r.status = 'pending') AS pending_run_id,
         (SELECT coalesce(d.display_name, d.hostname) FROM devices d WHERE d.id = t.device_id) AS device_label,
         (SELECT st.timezone FROM sites st WHERE st.id = t.site_id) AS site_timezone
    FROM config_backup_targets t`;

export type Readiness = 'ready' | 'disabled' | 'out_of_scope' | 'no_credentials' | 'credentials_unreadable' | 'credentials_rejected' | 'host_key_changed';

/** Whether a backup can run, and if not the first thing the administrator has to fix. */
export function readiness(t: TargetRow): Readiness {
  if (!t.enabled) return 'disabled';
  if (!t.in_scope) return 'out_of_scope';
  if (!t.secret_enc) return 'no_credentials';
  if (!openCredentials(t.secret_enc)) return 'credentials_unreadable';
  if (t.host_key_status === 'changed') return 'host_key_changed';
  if (t.credentials_rejected) return 'credentials_rejected';
  return 'ready';
}

const driverName = (id: string | null) => CONFIG_BACKUP_DRIVERS.find((d) => d.id === id)?.name ?? null;

/** The public representation. Credentials are write-only: only whether, which kind and when they were set. */
export function present(t: TargetRow) {
  const { secret_enc, site_timezone, ...rest } = t;
  const detection = t.detection as { confidence?: string } | null;
  return {
    ...rest,
    credentials: describeCredentials(secret_enc, t.credentials_updated_at),
    credentials_updated_at: undefined,
    // The vendor in use: the administrator's choice (manual) or the last detection (observed by the collector).
    vendor: t.driver
      ? { driver: t.driver, name: driverName(t.driver), source: 'manual' as const, confidence: null }
      : t.detected_driver
        ? { driver: t.detected_driver, name: driverName(t.detected_driver), source: 'observed' as const, confidence: detection?.confidence ?? null }
        : null,
    site_timezone,
    readiness: readiness(t),
  };
}

export async function loadTarget(db: Db, id: string, lock = false): Promise<TargetRow> {
  const t = (await db.query<TargetRow>(`${TARGET_SELECT} WHERE t.id = $1${lock ? ' FOR UPDATE OF t' : ''}`, [id])).rows[0];
  if (!t) throw notFound('Backup target');
  return t;
}

async function onlineCollector(db: Db, siteId: string): Promise<{ id: string; name: string } | null> {
  return (
    (
      await db.query<{ id: string; name: string }>(
        `SELECT id, name FROM collectors WHERE site_id = $1 AND status = 'active' AND last_heartbeat_at > now() - interval '3 minutes'
          ORDER BY last_heartbeat_at DESC LIMIT 1`,
        [siteId],
      )
    ).rows[0] ?? null
  );
}

/** Runs and reachability checks not reported in time expire; their commands are withdrawn. */
export async function expireStale(db: Db): Promise<void> {
  const runs = await db.query<{ command_id: string | null }>(
    `UPDATE config_backup_runs SET status = 'expired', error_kind = 'expired', completed_at = now(),
            error = 'The collector did not report a result in time (offline, or busy with other backups)'
      WHERE status = 'pending' AND expires_at < now() RETURNING command_id`,
  );
  const probes = await db.query<{ id: string }>(
    `UPDATE config_backup_probe_runs SET status = 'expired', completed_at = now() WHERE status = 'pending' AND expires_at < now() RETURNING id`,
  );
  const commandIds = runs.rows.map((r) => r.command_id).filter((x): x is string => !!x);
  if (commandIds.length) {
    await db.query(`UPDATE collector_commands SET status = 'completed', completed_at = now() WHERE id = ANY($1) AND status <> 'completed'`, [commandIds]);
  }
  if (probes.rowCount) {
    await db.query(
      `UPDATE collector_commands SET status = 'completed', completed_at = now()
        WHERE kind = 'config_backup_probe' AND status <> 'completed' AND payload->>'run_id' = ANY($1::text[])`,
      [probes.rows.map((p) => p.id)],
    );
  }
}

// ── targets ────────────────────────────────────────────────────────────────

export function listTargets(organizationId: string, siteId: string | undefined) {
  return withTenant(organizationId, async (db) => {
    await expireStale(db);
    return (await db.query<TargetRow>(`${TARGET_SELECT} WHERE ($1::uuid IS NULL OR t.site_id = $1) ORDER BY t.name, t.address`, [siteId ?? null])).rows.map(present);
  });
}

export function targetDetail(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    await expireStale(db);
    const t = await loadTarget(db, id);
    const runs = (
      await db.query(
        `SELECT r.id, r.trigger, r.status, r.outcome, r.version_id, r.host_key_status, r.error_kind, r.error, r.duration_ms, r.created_by_email,
                r.created_at, r.completed_at, (SELECT c.name FROM collectors c WHERE c.id = r.collector_id) AS collector_name
           FROM config_backup_runs r WHERE r.target_id = $1 ORDER BY r.created_at DESC LIMIT 25`,
        [id],
      )
    ).rows;
    return { ...present(t), runs, drivers: CONFIG_BACKUP_DRIVERS };
  });
}

async function checkInScope(db: Db, siteId: string, address: string): Promise<void> {
  const inScope = await db.query(`SELECT 1 FROM network_scopes WHERE site_id = $1 AND enabled AND $2::inet <<= cidr`, [siteId, address]);
  if (!inScope.rowCount) throw new AppError(422, 'not_in_scope', `${address} is not inside an authorized network range of the site`);
}

export function addTargets(req: Request, ctx: AuthContext, body: TargetsCreate) {
  return withTenant(ctx.organizationId, async (db) => {
    const site = (await db.query<{ timezone: string }>(`SELECT timezone FROM sites WHERE id = $1`, [body.site_id])).rows[0];
    if (!site) throw notFound('Site');
    const seen = new Set<string>();
    for (const t of body.targets) {
      const key = `${t.address}:${t.port}`;
      if (seen.has(key)) throw new AppError(422, 'duplicate_address', `${key} is listed twice`);
      seen.add(key);
      // Same boundary as discovery, SNMP and router control: a private address inside a range the
      // organization authorized (scopes are RFC 1918 only; the collector re-checks both).
      await checkInScope(db, body.site_id, t.address);
    }
    const count = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM config_backup_targets WHERE site_id = $1`, [body.site_id])).rows[0]!.n;
    if (count + body.targets.length > MAX_TARGETS_PER_SITE) throw new AppError(409, 'limit_reached', `A site can back up at most ${MAX_TARGETS_PER_SITE} devices`);
    const existing = await db.query<{ a: string; port: number }>(
      `SELECT host(address) AS a, port FROM config_backup_targets WHERE site_id = $1 AND address = ANY($2::inet[])`,
      [body.site_id, body.targets.map((t) => t.address)],
    );
    const dup = existing.rows.find((r) => body.targets.some((t) => t.address === r.a && t.port === r.port));
    if (dup) throw new AppError(409, 'already_added', `${dup.a}:${dup.port} is already backed up`);

    const sealed = body.credentials ? sealCredentials(body.credentials) : null;
    const now = new Date();
    const ids: string[] = [];
    for (const t of body.targets) {
      const device = (
        await db.query<{ id: string; label: string | null }>(
          `SELECT id, coalesce(display_name, hostname) AS label FROM devices WHERE site_id = $1 AND current_ip = $2::inet ORDER BY last_seen_at DESC LIMIT 1`,
          [body.site_id, t.address],
        )
      ).rows[0];
      const row = (
        await db.query<{ id: string }>(
          `INSERT INTO config_backup_targets (organization_id, site_id, device_id, name, address, port, driver, secret_enc, credentials_updated_at,
                                              credentials_updated_by, schedule, schedule_hour, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10) RETURNING id`,
          [
            ctx.organizationId,
            body.site_id,
            device?.id ?? null,
            (t.name ?? device?.label ?? t.address).slice(0, 80),
            t.address,
            t.port,
            t.driver,
            sealed,
            sealed ? now : null,
            ctx.userId,
            body.schedule,
            body.schedule_hour,
          ],
        )
      ).rows[0]!;
      if (body.schedule === 'daily') {
        await db.query(`UPDATE config_backup_targets SET next_run_at = $2 WHERE id = $1`, [row.id, nextDailyRun(now, site.timezone, body.schedule_hour, row.id)]);
      }
      ids.push(row.id);
      // The audit trail records that credentials were set, never what they are.
      await audit(db, req, 'config_backup.target.add', { type: 'config_backup_target', id: row.id }, {
        site_id: body.site_id,
        address: t.address,
        port: t.port,
        driver: t.driver ?? 'auto',
        schedule: body.schedule,
        schedule_hour: body.schedule_hour,
        credentials: { set: !!sealed },
      });
    }
    const queued: { target_id: string; run_id: string }[] = [];
    let noCollector = false;
    if (body.run_now && sealed) {
      const collector = await onlineCollector(db, body.site_id);
      if (!collector) noCollector = true;
      else {
        for (const id of ids) {
          const t = await loadTarget(db, id, true);
          if (readiness(t) !== 'ready') continue;
          const run = await queueRun(db, ctx.organizationId, t, 'manual', collector, { id: ctx.userId, email: ctx.userEmail });
          queued.push({ target_id: id, run_id: run.run_id });
        }
      }
    }
    await notifyRealtime(db, ctx.organizationId, 'devices');
    const items = [];
    for (const id of ids) items.push(present(await loadTarget(db, id)));
    return { items, queued, no_collector: noCollector };
  });
}

export function updateTarget(req: Request, ctx: AuthContext, id: string, body: TargetPatch) {
  return withTenant(ctx.organizationId, async (db) => {
    const current = await loadTarget(db, id, true);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (body.name !== undefined) set('name', body.name);
    if (body.port !== undefined && body.port !== current.port) {
      const clash = await db.query(`SELECT 1 FROM config_backup_targets WHERE site_id = $1 AND address = $2::inet AND port = $3 AND id <> $4`, [
        current.site_id,
        current.address,
        body.port,
        id,
      ]);
      if (clash.rowCount) throw new AppError(409, 'already_added', `${current.address}:${body.port} is already backed up`);
      set('port', body.port);
    }
    if (body.driver !== undefined) set('driver', body.driver);
    if (body.enabled !== undefined) set('enabled', body.enabled);
    const schedule = body.schedule ?? current.schedule;
    const hour = body.schedule_hour ?? current.schedule_hour;
    if (body.schedule !== undefined) set('schedule', body.schedule);
    if (body.schedule_hour !== undefined) set('schedule_hour', body.schedule_hour);
    if (body.schedule !== undefined || body.schedule_hour !== undefined) {
      set('next_run_at', schedule === 'daily' ? nextDailyRun(new Date(), current.site_timezone, hour, id) : null);
    }
    if (sets.length) await db.query(`UPDATE config_backup_targets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
    await audit(db, req, 'config_backup.target.update', { type: 'config_backup_target', id }, { ...body });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return present(await loadTarget(db, id));
  });
}

export function setCredentials(req: Request, ctx: AuthContext, id: string, body: { credentials: Credentials } | { copy_from_target_id: string }) {
  return withTenant(ctx.organizationId, async (db) => {
    await loadTarget(db, id, true);
    let sealed: string;
    let copiedFrom: string | null = null;
    if ('credentials' in body) {
      sealed = sealCredentials(body.credentials);
    } else {
      const source = await loadTarget(db, body.copy_from_target_id);
      const creds = openCredentials(source.secret_enc);
      if (!creds) throw new AppError(409, 'no_credentials', 'That device has no usable credentials to copy');
      sealed = sealCredentials(creds); // re-sealed: a fresh IV per stored copy
      copiedFrom = source.id;
    }
    // New credentials end the "rejected" pause: the administrator fixed what the device refused.
    await db.query(
      `UPDATE config_backup_targets SET secret_enc = $2, credentials_updated_at = now(), credentials_updated_by = $3, credentials_rejected = false, updated_at = now()
        WHERE id = $1`,
      [id, sealed, ctx.userId],
    );
    await audit(db, req, 'config_backup.credentials.set', { type: 'config_backup_target', id }, { credentials: { changed: true }, copied_from_target_id: copiedFrom });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return present(await loadTarget(db, id));
  });
}

export async function removeTarget(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const t = await loadTarget(db, id, true);
    // Withdraw a backup still waiting for the collector, so its credentials are no longer delivered.
    await db.query(
      `UPDATE collector_commands SET status = 'completed', completed_at = now()
        WHERE id IN (SELECT command_id FROM config_backup_runs WHERE target_id = $1 AND status = 'pending' AND command_id IS NOT NULL)`,
      [id],
    );
    await db.query(`DELETE FROM config_backup_targets WHERE id = $1`, [id]);
    await audit(db, req, 'config_backup.target.remove', { type: 'config_backup_target', id }, { name: t.name, address: t.address, versions_deleted: t.version_count });
    await notifyRealtime(db, ctx.organizationId, 'devices');
  });
}

// ── runs ───────────────────────────────────────────────────────────────────

const READINESS_ERRORS: Record<Exclude<Readiness, 'ready'>, string> = {
  disabled: 'Backups of this device are disabled',
  out_of_scope: 'The device address is no longer inside an authorized network range of the site',
  no_credentials: 'Set the SSH credentials of this device first',
  credentials_unreadable: 'The stored credentials cannot be decrypted (the application key changed); enter them again',
  credentials_rejected: 'The device rejected the user name or credentials. Update them; LAN Detective stopped logging in so the account is not locked',
  host_key_changed: 'The device presented a different SSH host key than the one pinned. Check why, then accept the new key before backing up again',
};

/** Records a backup run and queues its command (no secrets: they are added at delivery, commands.ts). */
export async function queueRun(
  db: Db,
  organizationId: string,
  t: TargetRow,
  trigger: 'manual' | 'scheduled',
  collector: { id: string; name: string },
  user: { id: string; email: string } | null,
): Promise<{ run_id: string; collector: string }> {
  const run = (
    await db.query<{ id: string }>(
      `INSERT INTO config_backup_runs (organization_id, site_id, target_id, collector_id, trigger, created_by, created_by_email, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => $8)) RETURNING id`,
      [organizationId, t.site_id, t.id, collector.id, trigger, user?.id ?? null, user?.email ?? null, RUN_TTL_MINUTES],
    )
  ).rows[0]!;
  const cmd = (
    await db.query<{ id: string }>(
      `INSERT INTO collector_commands (organization_id, collector_id, kind, payload, created_by) VALUES ($1,$2,'config_backup',$3,$4) RETURNING id`,
      [organizationId, collector.id, JSON.stringify({ run_id: run.id, target_id: t.id }), user?.id ?? null],
    )
  ).rows[0]!;
  await db.query(`UPDATE config_backup_runs SET command_id = $2 WHERE id = $1`, [run.id, cmd.id]);
  await db.query(`UPDATE config_backup_targets SET last_run_at = now() WHERE id = $1`, [t.id]);
  return { run_id: run.id, collector: collector.name };
}

export function runNow(req: Request, ctx: AuthContext, id: string) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStale(db);
    const t = await loadTarget(db, id, true);
    if (t.pending_run_id) return { run_id: t.pending_run_id, already_pending: true };
    const r = readiness(t);
    if (r !== 'ready') throw new AppError(409, `backup_${r}`, READINESS_ERRORS[r]);
    const collector = await onlineCollector(db, t.site_id);
    if (!collector) throw new AppError(409, 'no_collector', 'No collector of this site is online to reach the device');
    const q = await queueRun(db, ctx.organizationId, t, 'manual', collector, { id: ctx.userId, email: ctx.userEmail });
    await audit(db, req, 'config_backup.run', { type: 'config_backup_target', id }, { run_id: q.run_id });
    return { ...q, already_pending: false };
  });
}

export function runStatus(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    await expireStale(db);
    const row = (
      await db.query(
        `SELECT r.id, r.target_id, r.trigger, r.status, r.outcome, r.version_id, r.host_key_status, r.error_kind, r.error, r.duration_ms,
                r.created_by_email, r.created_at, r.completed_at, (SELECT c.name FROM collectors c WHERE c.id = r.collector_id) AS collector_name
           FROM config_backup_runs r WHERE r.id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) throw notFound('Backup run');
    return row;
  });
}

/** Accept the key the device now presents, after the administrator checked why it changed. */
export function acceptHostKey(req: Request, ctx: AuthContext, id: string, sha256: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const t = await loadTarget(db, id, true);
    if (t.host_key_status !== 'changed' || !t.presented_host_key) throw new AppError(409, 'no_new_host_key', 'The device has not presented a different host key');
    // Only the exact key the collector saw can be accepted; a typo or yet another key is refused.
    if (sha256 !== t.presented_host_key.sha256) throw new AppError(409, 'fingerprint_mismatch', 'This fingerprint is not the one the device presented');
    await db.query(
      `UPDATE config_backup_targets SET host_key_sha256 = $2, host_key_type = $3, host_key_pinned_at = now(), host_key_pinned_via = 'admin',
              host_key_status = 'pinned', presented_host_key = NULL, updated_at = now()
        WHERE id = $1`,
      [id, t.presented_host_key.sha256, t.presented_host_key.type],
    );
    await audit(db, req, 'config_backup.host_key.accept', { type: 'config_backup_target', id }, {
      previous: t.host_key_sha256,
      accepted: t.presented_host_key.sha256,
      key_type: t.presented_host_key.type,
    });
    await notifyRealtime(db, ctx.organizationId, 'devices');
    return present(await loadTarget(db, id));
  });
}

// ── versions ───────────────────────────────────────────────────────────────

const VERSION_COLUMNS = `v.id, v.target_id, v.number, v.sha256, v.captured_at, v.last_seen_at, v.confirmations, v.driver, v.added_lines, v.removed_lines,
  c.size_bytes, c.line_count, (SELECT co.name FROM collectors co WHERE co.id = v.collector_id) AS collector_name`;

export function listVersions(organizationId: string, targetId: string, limit: number) {
  return withTenant(organizationId, async (db) => {
    await loadTarget(db, targetId);
    const items = (
      await db.query(
        `SELECT ${VERSION_COLUMNS} FROM config_backup_versions v JOIN config_backup_contents c ON c.target_id = v.target_id AND c.sha256 = v.sha256
          WHERE v.target_id = $1 ORDER BY v.number DESC LIMIT $2`,
        [targetId, limit],
      )
    ).rows;
    return { items };
  });
}

interface VersionWithContent {
  id: string;
  target_id: string;
  number: number;
  sha256: string;
  captured_at: Date;
  content_enc: string;
  sanitized: boolean;
  target_name: string;
}

async function loadVersion(db: Db, id: string): Promise<VersionWithContent & { content: string }> {
  const v = (
    await db.query<VersionWithContent>(
      `SELECT v.id, v.target_id, v.number, v.sha256, v.captured_at, c.content_enc, c.sanitized, t.name AS target_name
         FROM config_backup_versions v
         JOIN config_backup_contents c ON c.target_id = v.target_id AND c.sha256 = v.sha256
         JOIN config_backup_targets t ON t.id = v.target_id
        WHERE v.id = $1`,
      [id],
    )
  ).rows[0];
  if (!v) throw notFound('Configuration version');
  let content: string;
  try {
    content = decryptSecret(v.content_enc);
  } catch {
    throw new AppError(409, 'content_unreadable', 'This configuration cannot be decrypted (the application key changed)');
  }
  // Stored before secret sanitization (migration 041) and not converted yet: never shown unsanitized.
  if (!v.sanitized) content = prepareConfig(content, await fingerprintKey(db, v.target_id)).text;
  return { ...v, content };
}

export function versionContent(req: Request, ctx: AuthContext, id: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const v = await loadVersion(db, id);
    const meta = (
      await db.query(
        `SELECT ${VERSION_COLUMNS} FROM config_backup_versions v JOIN config_backup_contents c ON c.target_id = v.target_id AND c.sha256 = v.sha256 WHERE v.id = $1`,
        [id],
      )
    ).rows[0];
    await audit(db, req, 'config_backup.version.view', { type: 'config_backup_version', id }, { target_id: v.target_id, number: v.number });
    return { ...meta, content: v.content };
  });
}

const safeFileName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'device';

export function downloadVersion(req: Request, ctx: AuthContext, id: string) {
  return withTenant(ctx.organizationId, async (db) => {
    const v = await loadVersion(db, id);
    await audit(db, req, 'config_backup.version.download', { type: 'config_backup_version', id }, { target_id: v.target_id, number: v.number });
    const day = v.captured_at.toISOString().slice(0, 10);
    return { filename: `${safeFileName(v.target_name)}-v${v.number}-${day}.cfg`, text: v.content };
  });
}

export function diffVersions(req: Request, ctx: AuthContext, targetId: string, fromId: string, toId: string, context: number, unified = false) {
  return withTenant(ctx.organizationId, async (db) => {
    const t = await loadTarget(db, targetId);
    const from = await loadVersion(db, fromId);
    const to = await loadVersion(db, toId);
    if (from.target_id !== t.id || to.target_id !== t.id) throw new AppError(422, 'wrong_target', 'Both versions must belong to this device');
    const diff = diffLines(from.content, to.content, context);
    await audit(db, req, 'config_backup.version.diff', { type: 'config_backup_target', id: targetId }, { from: from.number, to: to.number });
    const side = (v: VersionWithContent) => ({ id: v.id, number: v.number, captured_at: v.captured_at, sha256: v.sha256 });
    if (unified) {
      return {
        filename: `${safeFileName(t.name)}-v${from.number}-v${to.number}.diff`,
        text: unifiedText(diff, `${t.name} v${from.number} (${from.captured_at.toISOString()})`, `${t.name} v${to.number} (${to.captured_at.toISOString()})`),
      };
    }
    return { from: side(from), to: side(to), ...diff };
  });
}

// ── suggestions and SSH reachability ─────────────────────────────────────────

const NETWORK_TYPES = ['router', 'switch', 'firewall', 'access_point'];
const NOT_NETWORK_GEAR = ['windows_computer', 'apple_computer', 'mobile', 'printer', 'camera', 'media_player', 'iot'];

interface CandidateRow {
  address: string;
  device_id: string | null;
  name: string | null;
  device_type: string | null;
  type_source: string | null;
  vendor: string | null;
  sys_name: string | null;
  sys_descr: string | null;
  is_router: boolean;
  ssh_open: boolean | null;
  server_version: string | null;
  ssh_checked_at: Date | null;
}

/**
 * Devices of the site worth backing up, best first, each with the reasons (evidence) and a vendor
 * suggestion: network gear by classification, switches read over SNMP, routers under router control,
 * and anything else answering SSH that is not a computer, phone or printer.
 */
export function suggestions(organizationId: string, siteId: string) {
  return withTenant(organizationId, async (db) => {
    await expireStale(db);
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
    const rows = (
      await db.query<CandidateRow>(
        `WITH addrs AS (
           SELECT current_ip AS address FROM devices WHERE site_id = $1 AND current_ip IS NOT NULL
           UNION SELECT host FROM snmp_targets WHERE site_id = $1
           UNION SELECT address FROM site_routers WHERE site_id = $1
           UNION SELECT address FROM config_backup_probes WHERE site_id = $1 AND open
         )
         SELECT host(a.address) AS address, d.id AS device_id, d.name, d.device_type, d.type_source, d.vendor,
                s.sys_name, s.sys_descr,
                EXISTS (SELECT 1 FROM site_routers r WHERE r.site_id = $1 AND r.address = a.address) AS is_router,
                p.open AS ssh_open, p.server_version, p.checked_at AS ssh_checked_at
           FROM addrs a
           LEFT JOIN LATERAL (SELECT id, coalesce(display_name, hostname) AS name, device_type, type_source, vendor
                                FROM devices WHERE site_id = $1 AND current_ip = a.address ORDER BY last_seen_at DESC LIMIT 1) d ON true
           LEFT JOIN LATERAL (SELECT sys_name, sys_descr FROM snmp_targets WHERE site_id = $1 AND host = a.address LIMIT 1) s ON true
           LEFT JOIN config_backup_probes p ON p.site_id = $1 AND p.address = a.address AND p.port = 22
          WHERE EXISTS (SELECT 1 FROM network_scopes sc WHERE sc.site_id = $1 AND sc.enabled AND a.address <<= sc.cidr)
            AND NOT EXISTS (SELECT 1 FROM config_backup_targets t WHERE t.site_id = $1 AND t.address = a.address)
          ORDER BY a.address
          LIMIT 2000`,
        [siteId],
      )
    ).rows;
    const items = rows
      .map((r) => {
        const reasons: { source: 'observed' | 'inferred' | 'manual'; text: string }[] = [];
        if (r.device_type && NETWORK_TYPES.includes(r.device_type)) {
          reasons.push({ source: r.type_source === 'manual' ? 'manual' : 'inferred', text: `classified as ${r.device_type.replace('_', ' ')}` });
        }
        if (r.sys_descr) reasons.push({ source: 'observed', text: 'read over SNMP (Port Detective)' });
        if (r.is_router) reasons.push({ source: 'manual', text: 'added under router control' });
        if (r.ssh_open) reasons.push({ source: 'observed', text: `answers SSH${r.server_version ? ` (${r.server_version})` : ''}` });
        const gear = reasons.some((x) => !x.text.startsWith('answers SSH'));
        const include = gear || (r.ssh_open === true && !NOT_NETWORK_GEAR.includes(r.device_type ?? ''));
        if (!include) return null;
        const suggestion = suggestDriver({ serverVersion: r.server_version, sysDescr: r.sys_descr, ouiVendor: r.vendor });
        return {
          address: r.address,
          device_id: r.device_id,
          name: r.name ?? r.sys_name ?? null,
          device_type: r.device_type,
          vendor: r.vendor,
          ssh: { state: r.ssh_open === null ? 'unknown' : r.ssh_open ? 'open' : 'closed', server_version: r.server_version, checked_at: r.ssh_checked_at },
          suggested_driver: { ...suggestion, name: driverName(suggestion.driver), source: 'inferred' as const },
          reasons,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      // SSH answering first, then network gear, then by address.
      .sort((a, b) => Number(b.ssh.state === 'open') - Number(a.ssh.state === 'open') || Number(b.ssh.state !== 'closed') - Number(a.ssh.state !== 'closed'));
    const lastProbe = (
      await db.query(
        `SELECT id, trigger, status, address_count, open_count, created_at, completed_at FROM config_backup_probe_runs WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [siteId],
      )
    ).rows[0];
    return { items, last_probe: lastProbe ?? null, drivers: CONFIG_BACKUP_DRIVERS };
  });
}

/** Addresses of the site that an SSH reachability check covers: every known device inside an authorized scope. */
async function probeAddresses(db: Db, siteId: string): Promise<string[]> {
  return (
    await db.query<{ a: string }>(
      `SELECT DISTINCT host(x.address) AS a, x.address FROM (
          SELECT current_ip AS address FROM devices WHERE site_id = $1 AND current_ip IS NOT NULL AND status <> 'offline'
          UNION SELECT host FROM snmp_targets WHERE site_id = $1
          UNION SELECT address FROM site_routers WHERE site_id = $1
        ) x
        WHERE EXISTS (SELECT 1 FROM network_scopes sc WHERE sc.site_id = $1 AND sc.enabled AND x.address <<= sc.cidr)
        ORDER BY x.address LIMIT $2`,
      [siteId, MAX_PROBE_ADDRESSES],
    )
  ).rows.map((r) => r.a);
}

/** Queues a read-only SSH reachability check (TCP connect + identification line, no login). */
export async function queueProbe(
  db: Db,
  organizationId: string,
  siteId: string,
  trigger: 'manual' | 'scheduled',
  collector: { id: string; name: string },
  userId: string | null,
): Promise<{ probe_id: string; addresses: number; collector: string } | null> {
  const addresses = await probeAddresses(db, siteId);
  if (!addresses.length) return null;
  const run = (
    await db.query<{ id: string }>(
      `INSERT INTO config_backup_probe_runs (organization_id, site_id, collector_id, trigger, address_count, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7)) RETURNING id`,
      [organizationId, siteId, collector.id, trigger, addresses.length, userId, PROBE_TTL_MINUTES],
    )
  ).rows[0]!;
  await db.query(`INSERT INTO collector_commands (organization_id, collector_id, kind, payload, created_by) VALUES ($1,$2,'config_backup_probe',$3,$4)`, [
    organizationId,
    collector.id,
    JSON.stringify({ run_id: run.id, port: 22, addresses }),
    userId,
  ]);
  return { probe_id: run.id, addresses: addresses.length, collector: collector.name };
}

export function requestProbe(req: Request, ctx: AuthContext, siteId: string) {
  return withTenant(ctx.organizationId, async (db) => {
    await expireStale(db);
    if (!(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
    const pending = (await db.query<{ id: string }>(`SELECT id FROM config_backup_probe_runs WHERE site_id = $1 AND status = 'pending'`, [siteId])).rows[0];
    if (pending) return { probe_id: pending.id, already_pending: true };
    const collector = await onlineCollector(db, siteId);
    if (!collector) throw new AppError(409, 'no_collector', 'No collector of this site is online');
    const q = await queueProbe(db, ctx.organizationId, siteId, 'manual', collector, ctx.userId);
    if (!q) throw new AppError(409, 'nothing_to_check', 'No discovered device of this site is inside an authorized range yet');
    await audit(db, req, 'config_backup.probe', { type: 'site', id: siteId }, { probe_id: q.probe_id, addresses: q.addresses });
    return { ...q, already_pending: false };
  });
}

export function probeStatus(organizationId: string, id: string) {
  return withTenant(organizationId, async (db) => {
    await expireStale(db);
    const row = (
      await db.query(`SELECT id, site_id, trigger, status, address_count, open_count, created_at, completed_at FROM config_backup_probe_runs WHERE id = $1`, [id])
    ).rows[0];
    if (!row) throw notFound('SSH check');
    return row;
  });
}

export { onlineCollector };
