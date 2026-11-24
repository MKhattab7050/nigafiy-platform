import type { Request } from 'express';
import type { FleetPatchApproval, FleetPatchCatalogItem, FleetPatchInstall, FleetPatchPolicy, FleetPatchStatus, FleetPatchUpdate } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../../common/http.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { notifyRealtime } from '../../realtime/index.ts';
import { ONLINE_WITHIN_MS } from '../repo.ts';
import type { EndpointContext } from '../schema.ts';
import { type AgentPatchStatus, type PatchPolicyInput, installResultSchema } from './schema.ts';

// Patches (Fleet Pro, migration 043).
//
// The agent reports what each computer is missing (endpoint_patch_status). Admins approve or
// decline updates (for every group or one group), or let a policy approve whole classifications
// (security + critical, …). The scheduler (every minute) installs the approved updates only while
// a window is open: the site's maintenance windows (migration 019) or the group's weekly patch
// window, and only on computers whose agent can install (administrator / root). After an install
// that needs a restart, the reboot policy applies: never (shown only), ask (the person may choose
// "later" up to N times, until the deadline), or force (at the end of the window, 5-minute notice).
// Every decision, install and restart is audited; the history of a computer is never deleted.

const NOTICE_S = 300;
/** No answer to patch_install within this long: the install failed (the agent stopped). */
const INSTALL_ANSWER_HOURS = 4;
/** A restart question nobody answered (the agent lost it): asked again after the postponement. */
const PROMPT_ANSWER_MINUTES = 15;

const DEFAULT_POLICY: Omit<FleetPatchPolicy, 'fleet_group_id' | 'fleet_group_name'> = {
  id: null,
  enabled: false,
  auto_approve: [],
  window_kind: 'maintenance',
  window_weekdays: null,
  window_start: null,
  window_minutes: null,
  window_timezone: null,
  reboot_policy: 'ask',
  max_postponements: 3,
  postpone_minutes: 60,
  reboot_deadline_hours: 24,
  updated_by_email: null,
  updated_at: null,
};

const POLICY_COLUMNS = `p.id, p.fleet_group_id, g.name AS fleet_group_name, p.enabled, p.auto_approve, p.window_kind, p.window_weekdays::int[] AS window_weekdays,
  to_char(p.window_start, 'HH24:MI') AS window_start, p.window_minutes, p.window_timezone, p.reboot_policy, p.max_postponements, p.postpone_minutes,
  p.reboot_deadline_hours, p.updated_by_email, p.updated_at`;

const INSTALL_COLUMNS = `i.id, i.endpoint_id, e.name AS endpoint_name, i.source, i.state, i.updates, i.results, i.why, i.window_label, i.window_ends_at,
  i.queued_at, i.finished_at, i.error, i.reboot_required, i.reboot_state, i.reboot_policy, i.postponements, i.max_postponements,
  i.next_prompt_at, i.reboot_deadline, i.rebooted_at`;

const OPEN_INSTALL = `(i.state IN ('queued', 'installing') OR i.reboot_state IN ('asking', 'postponed', 'scheduled', 'restarting'))`;

async function systemAudit(db: Db, orgId: string, target: { type: string; id: string }, action: string, metadata: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
     VALUES ($1, NULL, NULL, $2, $3, $4, $5, 'system')`,
    [orgId, action, target.type, target.id, JSON.stringify({ ...metadata, source: 'fleet_patches' })],
  );
}

// ── Agent reports ──────────────────────────────────────────────────────────────────────────────

export async function recordPatchStatus(ep: EndpointContext, s: AgentPatchStatus): Promise<void> {
  const updates: FleetPatchUpdate[] = s.updates.map((u) => ({
    update_id: u.update_id,
    title: u.title,
    kb: u.kb ?? null,
    classification: u.classification,
    severity: u.severity || null,
    size_bytes: u.size_bytes ?? null,
    reboot_required: u.reboot_required ?? null,
    published_at: u.published_at ?? null,
  }));
  await withTenant(ep.organizationId, async (db) => {
    await db.query(
      `INSERT INTO endpoint_patch_status (endpoint_id, organization_id, source, install_supported, scanned_at, scan_error, reboot_pending, updates)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (endpoint_id) DO UPDATE SET source = EXCLUDED.source, install_supported = EXCLUDED.install_supported, scanned_at = EXCLUDED.scanned_at,
         scan_error = EXCLUDED.scan_error, reboot_pending = EXCLUDED.reboot_pending,
         -- A failed scan keeps the last known list (shown with the error).
         updates = CASE WHEN EXCLUDED.scan_error IS NOT NULL AND jsonb_array_length(EXCLUDED.updates) = 0 THEN endpoint_patch_status.updates ELSE EXCLUDED.updates END`,
      [ep.id, ep.organizationId, s.source, s.install_supported, s.scanned_at, s.scan_error || null, s.reboot_pending ?? null, JSON.stringify(updates)],
    );
    await notifyRealtime(db, ep.organizationId, 'devices');
  });
}

// ── Policies and decisions ─────────────────────────────────────────────────────────────────────

async function policyRows(db: Db): Promise<FleetPatchPolicy[]> {
  return (await db.query<FleetPatchPolicy>(`SELECT ${POLICY_COLUMNS} FROM fleet_patch_policies p LEFT JOIN fleet_groups g ON g.id = p.fleet_group_id ORDER BY g.name NULLS FIRST`)).rows;
}

function effective(policies: FleetPatchPolicy[], groupId: string | null): FleetPatchPolicy {
  return (
    (groupId ? policies.find((p) => p.fleet_group_id === groupId) : undefined) ??
    policies.find((p) => p.fleet_group_id === null) ?? { ...DEFAULT_POLICY, fleet_group_id: null, fleet_group_name: null }
  );
}

type Decision = 'approved' | 'auto_approved' | 'declined' | 'not_approved';

function decide(approvals: FleetPatchApproval[], update: { update_id: string; classification: string }, groupId: string | null, policy: FleetPatchPolicy): Decision {
  const own = approvals.filter((a) => a.update_id === update.update_id);
  const forGroup = groupId ? own.find((a) => a.fleet_group_id === groupId) : undefined;
  const forAll = own.find((a) => a.fleet_group_id === null);
  const d = forGroup ?? forAll;
  if (d) return d.decision;
  return (policy.auto_approve as string[]).includes(update.classification) ? 'auto_approved' : 'not_approved';
}

async function approvalRows(db: Db): Promise<FleetPatchApproval[]> {
  return (
    await db.query<FleetPatchApproval>(
      `SELECT a.id, a.update_id, a.fleet_group_id, g.name AS fleet_group_name, a.decision, a.title, a.kb, a.classification, a.decided_by_email, a.decided_at
         FROM fleet_patch_approvals a LEFT JOIN fleet_groups g ON g.id = a.fleet_group_id ORDER BY a.decided_at DESC`,
    )
  ).rows;
}

export async function listPolicies(ctx: AuthContext): Promise<{ policies: FleetPatchPolicy[]; default: FleetPatchPolicy }> {
  return withTenant(ctx.organizationId, async (db) => {
    const policies = await policyRows(db);
    return { policies, default: effective(policies, null) };
  });
}

export async function putPolicy(req: Request, ctx: AuthContext, b: PatchPolicyInput): Promise<FleetPatchPolicy> {
  return withTenant(ctx.organizationId, async (db) => {
    if (b.fleet_group_id && !(await db.query(`SELECT 1 FROM fleet_groups WHERE id = $1`, [b.fleet_group_id])).rows[0]) {
      throw new AppError(400, 'unknown_group', 'That Fleet group does not exist');
    }
    const values = [
      ctx.organizationId,
      b.fleet_group_id,
      b.enabled,
      b.auto_approve,
      b.window_kind,
      b.window_weekdays,
      b.window_start,
      b.window_minutes,
      b.window_timezone,
      b.reboot_policy,
      b.max_postponements,
      b.postpone_minutes,
      b.reboot_deadline_hours,
      ctx.userEmail,
    ];
    const set = `enabled = $3, auto_approve = $4, window_kind = $5, window_weekdays = $6::smallint[], window_start = $7::time, window_minutes = $8, window_timezone = $9,
      reboot_policy = $10, max_postponements = $11, postpone_minutes = $12, reboot_deadline_hours = $13, updated_by_email = $14, updated_at = now()`;
    const upd = await db.query(`UPDATE fleet_patch_policies SET ${set} WHERE fleet_group_id IS NOT DISTINCT FROM $2::uuid AND organization_id = $1`, values);
    if (!upd.rowCount) {
      await db.query(
        `INSERT INTO fleet_patch_policies (organization_id, fleet_group_id, enabled, auto_approve, window_kind, window_weekdays, window_start, window_minutes, window_timezone,
           reboot_policy, max_postponements, postpone_minutes, reboot_deadline_hours, updated_by_email)
         VALUES ($1,$2,$3,$4,$5,$6::smallint[],$7::time,$8,$9,$10,$11,$12,$13,$14)`,
        values,
      );
    }
    await audit(db, req, 'fleet.patch_policy_updated', { type: b.fleet_group_id ? 'fleet_group' : 'organization', id: b.fleet_group_id ?? ctx.organizationId }, { ...b });
    return effective(await policyRows(db), b.fleet_group_id);
  });
}

/** A group's own policy is removed: the organization default applies to it again. */
export async function deleteGroupPolicy(req: Request, ctx: AuthContext, groupId: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const del = await db.query(`DELETE FROM fleet_patch_policies WHERE fleet_group_id = $1`, [groupId]);
    if (!del.rowCount) throw notFound('Patch policy');
    await audit(db, req, 'fleet.patch_policy_removed', { type: 'fleet_group', id: groupId }, {});
  });
}

export async function setApproval(req: Request, ctx: AuthContext, b: { update_id: string; fleet_group_id: string | null; decision: 'approved' | 'declined' }): Promise<FleetPatchApproval> {
  return withTenant(ctx.organizationId, async (db) => {
    if (b.fleet_group_id && !(await db.query(`SELECT 1 FROM fleet_groups WHERE id = $1`, [b.fleet_group_id])).rows[0]) {
      throw new AppError(400, 'unknown_group', 'That Fleet group does not exist');
    }
    // The title, KB and classification come from what the agents reported, never from the request.
    const seen = (
      await db.query<{ title: string; kb: string | null; classification: string }>(
        `SELECT u->>'title' AS title, u->>'kb' AS kb, u->>'classification' AS classification
           FROM endpoint_patch_status s, jsonb_array_elements(s.updates) u WHERE u->>'update_id' = $1 LIMIT 1`,
        [b.update_id],
      )
    ).rows[0];
    const prior = (await db.query<{ title: string; kb: string | null; classification: string | null }>(`SELECT title, kb, classification FROM fleet_patch_approvals WHERE update_id = $1 LIMIT 1`, [b.update_id])).rows[0];
    const info = seen ?? prior;
    if (!info) throw new AppError(404, 'update_not_seen', 'No managed computer reported this update');
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO fleet_patch_approvals (organization_id, update_id, fleet_group_id, decision, title, kb, classification, decided_by, decided_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (organization_id, update_id, coalesce(fleet_group_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET decision = EXCLUDED.decision, decided_by = EXCLUDED.decided_by, decided_by_email = EXCLUDED.decided_by_email, decided_at = now()
         RETURNING id`,
        [ctx.organizationId, b.update_id, b.fleet_group_id, b.decision, info.title, info.kb, info.classification, ctx.userId, ctx.userEmail],
      )
    ).rows[0]!;
    await audit(db, req, b.decision === 'approved' ? 'fleet.patch_approved' : 'fleet.patch_declined', { type: 'fleet_patch', id: row.id }, {
      update_id: b.update_id,
      kb: info.kb,
      title: info.title,
      classification: info.classification,
      fleet_group_id: b.fleet_group_id,
    });
    return (await approvalRows(db)).find((a) => a.id === row.id)!;
  });
}

export async function deleteApproval(req: Request, ctx: AuthContext, id: string): Promise<void> {
  await withTenant(ctx.organizationId, async (db) => {
    const del = await db.query<{ update_id: string; decision: string; fleet_group_id: string | null; kb: string | null }>(
      `DELETE FROM fleet_patch_approvals WHERE id = $1 RETURNING update_id, decision, fleet_group_id, kb`,
      [id],
    );
    const r = del.rows[0];
    if (!r) throw notFound('Approval');
    await audit(db, req, 'fleet.patch_approval_removed', { type: 'fleet_patch', id }, { ...r });
  });
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────

export async function catalog(ctx: AuthContext): Promise<{ updates: FleetPatchCatalogItem[]; approvals: FleetPatchApproval[] }> {
  return withTenant(ctx.organizationId, async (db) => {
    const statuses = (await db.query<{ source: FleetPatchCatalogItem['source'] | 'none'; updates: FleetPatchUpdate[] }>(`SELECT source, updates FROM endpoint_patch_status`)).rows;
    const approvals = await approvalRows(db);
    const byId = new Map<string, FleetPatchCatalogItem>();
    for (const s of statuses) {
      if (s.source === 'none') continue;
      for (const u of s.updates) {
        const item = byId.get(u.update_id);
        if (item) item.missing_on++;
        else byId.set(u.update_id, { ...u, source: s.source, missing_on: 1, approvals: approvals.filter((a) => a.update_id === u.update_id) });
      }
    }
    const order = ['critical', 'security', 'definition', 'update_rollup', 'service_pack', 'feature_pack', 'update', 'driver', 'tool', 'upgrade', 'other'];
    const updates = [...byId.values()].sort((a, b) => order.indexOf(a.classification) - order.indexOf(b.classification) || b.missing_on - a.missing_on || a.title.localeCompare(b.title));
    return { updates, approvals };
  });
}

export async function endpointPatches(ctx: AuthContext, endpointId: string): Promise<{ status: FleetPatchStatus | null; policy: FleetPatchPolicy; installs: FleetPatchInstall[] }> {
  return withTenant(ctx.organizationId, async (db) => {
    const ep = (await db.query<{ fleet_group_id: string | null }>(`SELECT fleet_group_id FROM endpoints WHERE id = $1`, [endpointId])).rows[0];
    if (!ep) throw notFound('Endpoint');
    const policy = effective(await policyRows(db), ep.fleet_group_id);
    const approvals = await approvalRows(db);
    const s = (await db.query<Omit<FleetPatchStatus, 'updates'> & { updates: FleetPatchUpdate[] }>(`SELECT endpoint_id, source, install_supported, scanned_at, scan_error, reboot_pending, updates FROM endpoint_patch_status WHERE endpoint_id = $1`, [endpointId])).rows[0];
    const status: FleetPatchStatus | null = s ? { ...s, updates: s.updates.map((u) => ({ ...u, approval: decide(approvals, u, ep.fleet_group_id, policy) })) } : null;
    const installs = (await db.query<FleetPatchInstall>(`SELECT ${INSTALL_COLUMNS} FROM fleet_patch_installs i JOIN endpoints e ON e.id = i.endpoint_id WHERE i.endpoint_id = $1 ORDER BY i.queued_at DESC LIMIT 100`, [endpointId])).rows;
    return { status, policy, installs };
  });
}

export async function listInstalls(ctx: AuthContext, q: { endpoint_id?: string | undefined; open?: '1' | '0' | undefined; limit: number }): Promise<FleetPatchInstall[]> {
  return withTenant(ctx.organizationId, async (db) => {
    const where = [q.endpoint_id ? `i.endpoint_id = $2` : null, q.open === '1' ? OPEN_INSTALL : q.open === '0' ? `NOT ${OPEN_INSTALL}` : null].filter(Boolean);
    return (
      await db.query<FleetPatchInstall>(
        `SELECT ${INSTALL_COLUMNS} FROM fleet_patch_installs i JOIN endpoints e ON e.id = i.endpoint_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.queued_at DESC LIMIT $1`,
        q.endpoint_id ? [q.limit, q.endpoint_id] : [q.limit],
      )
    ).rows;
  });
}

// ── Operator actions ───────────────────────────────────────────────────────────────────────────

export async function requestScan(req: Request, ctx: AuthContext, endpointId: string): Promise<{ command_id: string }> {
  return withTenant(ctx.organizationId, async (db) => {
    const ep = (await db.query<{ status: string }>(`SELECT status FROM endpoints WHERE id = $1`, [endpointId])).rows[0];
    if (!ep) throw notFound('Endpoint');
    if (ep.status !== 'active') throw new AppError(409, 'endpoint_not_active', 'This computer is not active');
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by, created_by_name) VALUES ($1,$2,'patch_scan','{}',$3,$4) RETURNING id`,
        [ctx.organizationId, endpointId, ctx.userId, ctx.userEmail],
      )
    ).rows[0]!.id;
    await audit(db, req, 'endpoint.patch_scan_requested', { type: 'endpoint', id: endpointId }, { command_id: id });
    return { command_id: id };
  });
}

/** A queued install the agent has not taken yet is cancelled (admin). */
export async function cancelInstall(req: Request, ctx: AuthContext, id: string): Promise<FleetPatchInstall> {
  return withTenant(ctx.organizationId, async (db) => {
    const i = (await db.query<{ state: string; command_id: string | null; endpoint_id: string }>(`SELECT state, command_id, endpoint_id FROM fleet_patch_installs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!i) throw notFound('Install');
    const taken = i.command_id ? (await db.query(`UPDATE endpoint_commands SET status = 'expired', completed_at = now(), error = 'Cancelled before the agent took it' WHERE id = $1 AND status = 'pending'`, [i.command_id])).rowCount : 1;
    if (i.state !== 'queued' || !taken) throw new AppError(409, 'install_started', 'The computer already started this install; it cannot be cancelled');
    await db.query(`UPDATE fleet_patch_installs SET state = 'cancelled', finished_at = now(), error = $2 WHERE id = $1`, [id, `Cancelled by ${ctx.userEmail}`]);
    await audit(db, req, 'fleet.patch_install_cancelled', { type: 'endpoint', id: i.endpoint_id }, { install_id: id });
    return (await db.query<FleetPatchInstall>(`SELECT ${INSTALL_COLUMNS} FROM fleet_patch_installs i JOIN endpoints e ON e.id = i.endpoint_id WHERE i.id = $1`, [id])).rows[0]!;
  });
}

// ── Scheduler ──────────────────────────────────────────────────────────────────────────────────

interface Window {
  label: string;
  ends_at: Date;
}

/** The window open now for this computer under this policy, or null. */
async function openWindow(db: Db, ep: { organization_id: string; site_id: string; device_id: string | null }, p: FleetPatchPolicy): Promise<Window | null> {
  if (p.window_kind === 'group') {
    const r = (
      await db.query<{ ends: Date | null }>(
        `SELECT upper(maintenance_occurrence(timestamp '2000-01-01' + $1::time, timestamp '2000-01-01' + $1::time + make_interval(mins => $2), $3, $4::smallint[], NULL, now())) AS ends`,
        [p.window_start, p.window_minutes, p.window_timezone, p.window_weekdays],
      )
    ).rows[0];
    return r?.ends ? { label: `Patch window of ${p.fleet_group_name ?? 'the organization'} (${p.window_start}, ${p.window_minutes} min, ${p.window_timezone})`, ends_at: r.ends } : null;
  }
  const r = (
    await db.query<{ ends: Date; reason: string }>(
      `SELECT upper(o) AS ends, w.reason
         FROM maintenance_windows w, maintenance_occurrence(w.starts_local, w.ends_local, w.timezone, w.weekdays, w.recur_until, now()) o
        WHERE w.organization_id = $1 AND (w.site_id IS NULL OR w.site_id = $2) AND (w.target_all OR $3::uuid = ANY(w.device_ids)) AND o IS NOT NULL
        ORDER BY upper(o) DESC LIMIT 1`,
      [ep.organization_id, ep.site_id, ep.device_id],
    )
  ).rows[0];
  return r ? { label: `Maintenance window: ${r.reason}`, ends_at: r.ends } : null;
}

interface Candidate {
  id: string;
  organization_id: string;
  site_id: string;
  device_id: string | null;
  fleet_group_id: string | null;
  source: 'wua' | 'apt' | 'dnf' | 'softwareupdate';
  updates: FleetPatchUpdate[];
  scanned_at: Date;
  online: boolean;
  last_finished: Date | null;
  open_install: boolean;
}

async function queueCommand(db: Db, orgId: string, endpointId: string, kind: string, payload: Record<string, unknown>): Promise<string> {
  return (
    await db.query<{ id: string }>(`INSERT INTO endpoint_commands (organization_id, endpoint_id, kind, payload, created_by_name) VALUES ($1,$2,$3,$4,'Nigafiy patching') RETURNING id`, [
      orgId,
      endpointId,
      kind,
      JSON.stringify(payload),
    ])
  ).rows[0]!.id;
}

/** Approved updates go to computers whose window is open (one install per computer at a time). */
export async function dispatchInstalls(orgId: string): Promise<number> {
  return withTenant(orgId, async (db) => {
    const policies = await policyRows(db);
    if (!policies.some((p) => p.enabled)) return 0;
    const approvals = await approvalRows(db);
    const rows = (
      await db.query<Candidate>(
        `SELECT e.id, e.organization_id, e.site_id, e.device_id, e.fleet_group_id, s.source, s.updates, s.scanned_at,
                (e.status = 'active' AND e.last_heartbeat_at > now() - make_interval(secs => $1)) AS online,
                (SELECT max(i.finished_at) FROM fleet_patch_installs i WHERE i.endpoint_id = e.id AND i.state <> 'cancelled') AS last_finished,
                EXISTS (SELECT 1 FROM fleet_patch_installs i WHERE i.endpoint_id = e.id AND ${OPEN_INSTALL}) AS open_install
           FROM endpoint_patch_status s JOIN endpoints e ON e.id = s.endpoint_id
          WHERE s.install_supported AND s.source <> 'none' AND jsonb_array_length(s.updates) > 0`,
        [ONLINE_WITHIN_MS / 1000],
      )
    ).rows;
    let queued = 0;
    for (const ep of rows) {
      // Wait for a fresh scan after the last install (what it installed is no longer missing). A cancelled
      // install was never delivered and changed nothing, so it does not wait for a new scan.
      if (!ep.online || ep.open_install || (ep.last_finished && ep.last_finished >= ep.scanned_at)) continue;
      const policy = effective(policies, ep.fleet_group_id);
      if (!policy.enabled) continue;
      const chosen = ep.updates.map((u) => ({ u, d: decide(approvals, u, ep.fleet_group_id, policy) })).filter((x) => x.d === 'approved' || x.d === 'auto_approved');
      if (chosen.length === 0) continue;
      const win = await openWindow(db, ep, policy);
      if (!win) continue;
      const updates = chosen.slice(0, 200).map(({ u }) => ({ update_id: u.update_id, title: u.title, kb: u.kb, classification: u.classification }));
      const why = chosen.every((x) => x.d === 'auto_approved') ? 'auto_approved' : 'approved';
      const install = (
        await db.query<{ id: string }>(
          `INSERT INTO fleet_patch_installs (organization_id, endpoint_id, source, updates, why, window_label, window_ends_at, reboot_policy, max_postponements)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [orgId, ep.id, ep.source, JSON.stringify(updates), why, win.label.slice(0, 300), win.ends_at, policy.reboot_policy, policy.max_postponements],
        )
      ).rows[0]!.id;
      const cmd = await queueCommand(db, orgId, ep.id, 'patch_install', { install_id: install, updates: updates.map((u) => ({ update_id: u.update_id, title: u.title, kb: u.kb ?? undefined })) });
      await db.query(`UPDATE fleet_patch_installs SET command_id = $2 WHERE id = $1`, [install, cmd]);
      await systemAudit(db, orgId, { type: 'endpoint', id: ep.id }, 'fleet.patch_install_queued', {
        install_id: install,
        command_id: cmd,
        why,
        window: win.label,
        window_ends_at: win.ends_at.toISOString(),
        updates: updates.map((u) => u.kb ?? u.update_id),
      });
      queued++;
    }
    if (queued) await notifyRealtime(db, orgId, 'devices');
    return queued;
  });
}

function promptText(postponeMinutes: number, left: number, deadline: Date): string {
  const at = `${deadline.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return [
    'Nigafiy: updates approved by your IT team were installed on this computer. It needs to restart to finish.',
    `Restart now? Choose No to be asked again in ${postponeMinutes} minutes (${left} postponement${left === 1 ? '' : 's'} left). The restart happens by ${at} at the latest. Save your work first.`,
    '',
    'Nigafiy: ثُبّتت على هذا الحاسوب تحديثات وافق عليها فريق تقنية المعلومات، ويحتاج إلى إعادة التشغيل لإكمالها.',
    `إعادة التشغيل الآن؟ اختر «لا» ليُطرح السؤال مجددًا بعد ${postponeMinutes} دقيقة (التأجيلات المتبقية: ${left}). تحدث إعادة التشغيل في موعد أقصاه ${at}. احفظ عملك أولًا.`,
  ].join('\n');
}

const RESTART_MESSAGE =
  'Nigafiy: this computer restarts in a few minutes to finish installing updates approved by your IT team. Save your work. / Nigafiy: يُعاد تشغيل هذا الحاسوب بعد دقائق لإكمال تثبيت تحديثات وافق عليها فريق تقنية المعلومات. احفظ عملك.';

async function startRestart(db: Db, orgId: string, i: { id: string; endpoint_id: string }, reason: string, noticeS: number): Promise<void> {
  const cmd = await queueCommand(db, orgId, i.endpoint_id, 'patch_reboot', { install_id: i.id, message: RESTART_MESSAGE, notice_s: noticeS });
  await db.query(`UPDATE fleet_patch_installs SET reboot_state = 'restarting', reboot_command_id = $2, next_prompt_at = NULL WHERE id = $1`, [i.id, cmd]);
  await systemAudit(db, orgId, { type: 'endpoint', id: i.endpoint_id }, 'fleet.patch_restart', { install_id: i.id, command_id: cmd, reason, notice_s: noticeS });
}

async function askRestart(db: Db, orgId: string, i: { id: string; endpoint_id: string; postponements: number; max_postponements: number; reboot_deadline: Date }, postponeMinutes: number): Promise<void> {
  const left = i.max_postponements - i.postponements;
  const cmd = await queueCommand(db, orgId, i.endpoint_id, 'patch_reboot_prompt', { install_id: i.id, text: promptText(postponeMinutes, left, i.reboot_deadline), can_postpone: true, timeout_s: 300 });
  await db.query(`UPDATE fleet_patch_installs SET reboot_state = 'asking', reboot_command_id = $2, next_prompt_at = now() + make_interval(mins => $3) WHERE id = $1`, [i.id, cmd, PROMPT_ANSWER_MINUTES]);
  await systemAudit(db, orgId, { type: 'endpoint', id: i.endpoint_id }, 'fleet.patch_restart_asked', { install_id: i.id, command_id: cmd, postponements_left: left });
}

/** The restart that follows an install, under the policy copied onto the install. */
async function afterInstall(db: Db, orgId: string, installId: string): Promise<void> {
  const i = (
    await db.query<{ id: string; endpoint_id: string; reboot_policy: 'never' | 'ask' | 'force' | null; max_postponements: number; window_ends_at: Date | null; postponements: number; online: boolean; fleet_group_id: string | null }>(
      `SELECT i.id, i.endpoint_id, i.reboot_policy, i.max_postponements, i.window_ends_at, i.postponements, e.fleet_group_id,
              (e.last_heartbeat_at > now() - make_interval(secs => $2)) AS online
         FROM fleet_patch_installs i JOIN endpoints e ON e.id = i.endpoint_id WHERE i.id = $1`,
      [installId, ONLINE_WITHIN_MS / 1000],
    )
  ).rows[0];
  if (!i) return;
  const policy = effective(await policyRows(db), i.fleet_group_id);
  if (i.reboot_policy === 'never') {
    await db.query(`UPDATE fleet_patch_installs SET reboot_state = 'pending' WHERE id = $1`, [i.id]);
    return;
  }
  if (i.reboot_policy === 'force') {
    const at = i.window_ends_at && i.window_ends_at.getTime() > Date.now() ? i.window_ends_at : new Date();
    await db.query(`UPDATE fleet_patch_installs SET reboot_state = 'scheduled', reboot_deadline = $2 WHERE id = $1`, [i.id, at]);
    return;
  }
  const deadline = new Date(Date.now() + policy.reboot_deadline_hours * 3_600_000);
  await db.query(`UPDATE fleet_patch_installs SET reboot_deadline = $2 WHERE id = $1`, [i.id, deadline]);
  if (i.max_postponements <= 0) return startRestart(db, orgId, i, 'no postponement allowed', NOTICE_S);
  await askRestart(db, orgId, { ...i, reboot_deadline: deadline }, policy.postpone_minutes);
}

/** Restart questions, postponements, deadlines, forced restarts and lost answers. */
export async function runRebootTimers(orgId: string): Promise<void> {
  await withTenant(orgId, async (db) => {
    const policies = await policyRows(db);
    const due = (
      await db.query<{
        id: string;
        endpoint_id: string;
        state: string;
        reboot_state: string;
        postponements: number;
        max_postponements: number;
        reboot_deadline: Date | null;
        next_prompt_at: Date | null;
        fleet_group_id: string | null;
        online: boolean;
        command_id: string | null;
        install_overdue: boolean;
      }>(
        `SELECT i.id, i.endpoint_id, i.state, i.reboot_state, i.postponements, i.max_postponements, i.reboot_deadline, i.next_prompt_at, e.fleet_group_id, i.command_id,
                (e.last_heartbeat_at > now() - make_interval(secs => $1)) AS online,
                (i.state IN ('queued', 'installing') AND i.queued_at < now() - make_interval(hours => $2)) AS install_overdue
           FROM fleet_patch_installs i JOIN endpoints e ON e.id = i.endpoint_id
          WHERE ${OPEN_INSTALL}
          FOR UPDATE OF i SKIP LOCKED`,
        [ONLINE_WITHIN_MS / 1000, INSTALL_ANSWER_HOURS],
      )
    ).rows;
    const now = Date.now();
    for (const i of due) {
      if (i.state === 'queued' || i.state === 'installing') {
        const cmd = i.command_id ? (await db.query<{ status: string; error: string | null }>(`SELECT status, error FROM endpoint_commands WHERE id = $1`, [i.command_id])).rows[0] : undefined;
        if (cmd?.status === 'delivered' && i.state === 'queued') await db.query(`UPDATE fleet_patch_installs SET state = 'installing' WHERE id = $1`, [i.id]);
        if (cmd?.status === 'expired' || i.install_overdue) {
          const error = cmd?.status === 'expired' ? 'The computer did not take the install (it went offline); it is queued again in the next open window' : 'No answer from the agent within 4 hours';
          await db.query(`UPDATE endpoint_commands SET status = 'expired', completed_at = now() WHERE id = $1 AND status IN ('pending', 'delivered')`, [i.command_id]);
          await db.query(`UPDATE fleet_patch_installs SET state = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [i.id, error]);
          await systemAudit(db, orgId, { type: 'endpoint', id: i.endpoint_id }, 'fleet.patch_install_finished', { install_id: i.id, state: 'failed', error });
        }
        continue;
      }
      const policy = effective(policies, i.fleet_group_id);
      const deadlinePassed = i.reboot_deadline !== null && i.reboot_deadline.getTime() <= now;
      const promptDue = i.next_prompt_at !== null && i.next_prompt_at.getTime() <= now;
      if (!i.online) continue;
      if (i.reboot_state === 'scheduled' && deadlinePassed) {
        await startRestart(db, orgId, i, 'end of the maintenance window (reboot policy: force)', NOTICE_S);
      } else if ((i.reboot_state === 'postponed' || i.reboot_state === 'asking') && (deadlinePassed || (promptDue && i.postponements >= i.max_postponements))) {
        await startRestart(db, orgId, i, deadlinePassed ? 'restart deadline reached' : 'no postponement left', NOTICE_S);
      } else if ((i.reboot_state === 'postponed' || i.reboot_state === 'asking') && promptDue && i.reboot_deadline) {
        // Postponement over, or the question was lost (no answer within 15 minutes): ask again.
        await askRestart(db, orgId, { ...i, reboot_deadline: i.reboot_deadline }, policy.postpone_minutes);
      }
    }
  });
}

/** What the agent answered to patch_install, patch_reboot_prompt and patch_reboot (inside applyCommandResults). */
export async function applyPatchResult(db: Db, orgId: string, endpointId: string, kind: string, payload: Record<string, unknown>, ok: boolean, data: Record<string, unknown> | null, error: string | null): Promise<void> {
  const installId = typeof payload.install_id === 'string' ? payload.install_id : null;
  if (!installId) return;
  if (kind === 'patch_install') {
    const parsed = installResultSchema.safeParse(data ?? {});
    const results = parsed.success ? (parsed.data.results ?? []) : [];
    const rebootRequired = parsed.success && parsed.data.reboot_required;
    const good = results.filter((r) => r.result === 'succeeded' || (r.result === 'not_started' && /no longer missing/.test(r.hresult ?? ''))).length;
    const state = !ok && results.length === 0 ? 'failed' : good === results.length && results.length > 0 && ok ? 'succeeded' : good > 0 ? 'partial' : 'failed';
    const upd = await db.query(
      `UPDATE fleet_patch_installs SET state = $3, results = $4, error = $5, finished_at = now(), reboot_required = $6
        WHERE id = $1 AND endpoint_id = $2 AND state IN ('queued', 'installing')`,
      [installId, endpointId, state, JSON.stringify(results.map((r) => ({ update_id: r.update_id, result: r.result, hresult: r.hresult ?? null, reboot_required: r.reboot_required ?? false }))), error?.slice(0, 1000) ?? null, rebootRequired],
    );
    if (!upd.rowCount) return;
    await systemAudit(db, orgId, { type: 'endpoint', id: endpointId }, 'fleet.patch_install_finished', {
      install_id: installId,
      state,
      succeeded: results.filter((r) => r.result === 'succeeded').map((r) => r.update_id),
      failed: results.filter((r) => r.result === 'failed' || r.result === 'aborted').map((r) => ({ update_id: r.update_id, hresult: r.hresult ?? null })),
      reboot_required: rebootRequired,
      error: error?.slice(0, 300) ?? null,
    });
    if (rebootRequired) await afterInstall(db, orgId, installId);
    await notifyRealtime(db, orgId, 'devices');
    return;
  }
  const i = (await db.query<{ id: string; endpoint_id: string; postponements: number; max_postponements: number; reboot_deadline: Date | null; reboot_state: string; fleet_group_id: string | null }>(
    `SELECT i.id, i.endpoint_id, i.postponements, i.max_postponements, i.reboot_deadline, i.reboot_state, e.fleet_group_id
       FROM fleet_patch_installs i JOIN endpoints e ON e.id = i.endpoint_id WHERE i.id = $1 AND i.endpoint_id = $2 FOR UPDATE OF i`,
    [installId, endpointId],
  )).rows[0];
  if (!i) return;
  if (kind === 'patch_reboot_prompt') {
    if (i.reboot_state !== 'asking') return;
    const answer = typeof data?.answer === 'string' ? data.answer : 'no_answer';
    await systemAudit(db, orgId, { type: 'endpoint', id: endpointId }, 'fleet.patch_restart_answer', { install_id: installId, answer });
    if (answer === 'restart' || answer === 'no_user') {
      await startRestart(db, orgId, i, answer === 'restart' ? 'the person chose to restart now' : 'nobody is signed in', answer === 'restart' ? 15 : 60);
      return;
    }
    const policy = effective(await policyRows(db), i.fleet_group_id);
    const count = answer === 'postpone' ? i.postponements + 1 : i.postponements;
    const next = new Date(Math.min(Date.now() + policy.postpone_minutes * 60_000, i.reboot_deadline?.getTime() ?? Infinity));
    await db.query(`UPDATE fleet_patch_installs SET reboot_state = 'postponed', postponements = $2, next_prompt_at = $3 WHERE id = $1`, [installId, count, next]);
    return;
  }
  if (kind === 'patch_reboot') {
    if (!ok) {
      await db.query(`UPDATE fleet_patch_installs SET reboot_state = 'failed', error = coalesce(error, $2) WHERE id = $1`, [installId, `Restart failed: ${error ?? 'unknown error'}`.slice(0, 1000)]);
      await systemAudit(db, orgId, { type: 'endpoint', id: endpointId }, 'fleet.patch_restart_failed', { install_id: installId, error: error?.slice(0, 300) ?? null });
    }
  }
}

/** Heartbeat: a computer that booted after its patch restart started is back (reboot done). */
export async function onHeartbeatPatches(db: Db, orgId: string, endpointId: string, uptimeSeconds: number): Promise<void> {
  const rows = (
    await db.query<{ id: string; started: Date }>(
      `SELECT i.id, c.created_at AS started FROM fleet_patch_installs i JOIN endpoint_commands c ON c.id = i.reboot_command_id
        WHERE i.endpoint_id = $1 AND i.reboot_state = 'restarting'`,
      [endpointId],
    )
  ).rows;
  for (const r of rows) {
    if (Date.now() - uptimeSeconds * 1000 < r.started.getTime() - 5_000) continue;
    await db.query(`UPDATE fleet_patch_installs SET reboot_state = 'done', rebooted_at = now() WHERE id = $1`, [r.id]);
    await systemAudit(db, orgId, { type: 'endpoint', id: endpointId }, 'fleet.patch_restart_done', { install_id: r.id });
  }
}

/** The module job (every 30 s): installs into open windows, then the restart timers. */
export async function runPatchScheduler(): Promise<void> {
  const orgs = await withSystem(
    async (db) =>
      (
        await db.query<{ organization_id: string }>(
          `SELECT organization_id FROM fleet_patch_policies WHERE enabled
           UNION SELECT organization_id FROM fleet_patch_installs i WHERE ${OPEN_INSTALL}`,
        )
      ).rows.map((r) => r.organization_id),
  );
  for (const o of orgs) {
    await dispatchInstalls(o);
    await runRebootTimers(o);
  }
}
