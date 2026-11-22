import type { Db } from '../../infrastructure/db.ts';
import { type ActionKey, type Risk } from './catalog.ts';
import type { Step, Trigger } from './schema.ts';

export type ApprovalMode = 'always_ask' | 'run_automatically';
export type RunStatus = 'queued' | 'running' | 'waiting' | 'awaiting_approval' | 'succeeded' | 'stopped' | 'failed' | 'rejected' | 'expired' | 'cancelled' | 'skipped';
export type StepStatus = 'pending' | 'awaiting_approval' | 'approved' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'rejected' | 'expired' | 'previewed' | 'cancelled';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting', 'awaiting_approval'];

export interface PlaybookRow {
  id: string;
  organization_id: string;
  site_id: string | null;
  site_name: string | null;
  site_timezone: string | null;
  name: string;
  description: string;
  enabled: boolean;
  dry_run: boolean;
  trigger: Trigger;
  steps: Step[];
  approval_mode: ApprovalMode;
  auto_run_set_by: string | null;
  auto_run_set_by_email: string | null;
  auto_run_set_at: Date | null;
  max_runs_per_hour: number;
  template_key: string | null;
  version: number;
  enabled_at: Date | null;
  created_by: string | null;
  created_by_email: string | null;
  updated_by: string | null;
  updated_by_email: string | null;
  created_at: Date;
  updated_at: Date;
}

export const PLAYBOOK_SELECT = `
  SELECT p.id, p.organization_id, p.site_id, s.name AS site_name, s.timezone AS site_timezone, p.name, p.description, p.enabled, p.dry_run,
         p.trigger, p.steps, p.approval_mode, p.auto_run_set_by, p.auto_run_set_by_email, p.auto_run_set_at, p.max_runs_per_hour,
         p.template_key, p.version, p.enabled_at, p.created_by, p.created_by_email, p.updated_by, p.updated_by_email, p.created_at, p.updated_at
    FROM playbooks p
    LEFT JOIN sites s ON s.organization_id = p.organization_id AND s.id = p.site_id`;

export interface RunRow {
  id: string;
  organization_id: string;
  playbook_id: string | null;
  playbook_name: string;
  playbook_version: number;
  site_id: string | null;
  device_id: string | null;
  incident_id: string | null;
  event_id: string | null;
  trigger_kind: 'event' | 'incident' | 'schedule' | 'manual';
  trigger_key: string;
  evidence: Record<string, unknown>;
  dry_run: boolean;
  approval_mode: ApprovalMode;
  status: RunStatus;
  status_reason: string | null;
  current_position: number;
  next_run_at: Date;
  caused_by_run_id: string | null;
  chain: string[];
  author_ids: string[];
  started_by: string | null;
  started_by_email: string | null;
  started_by_role: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export const RUN_COLUMNS = `r.id, r.organization_id, r.playbook_id, r.playbook_name, r.playbook_version, r.site_id, r.device_id, r.incident_id, r.event_id,
  r.trigger_kind, r.trigger_key, r.evidence, r.dry_run, r.approval_mode, r.status, r.status_reason, r.current_position, r.next_run_at,
  r.caused_by_run_id, r.chain, r.author_ids, r.started_by, r.started_by_email, r.started_by_role, r.created_at, r.finished_at`;

export interface StepRow {
  id: string;
  organization_id: string;
  run_id: string;
  position: number;
  step_key: string;
  action: ActionKey;
  params: Record<string, unknown>;
  risk: Risk;
  on_error: 'stop' | 'continue';
  status: StepStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  external: ExternalRef | null;
  actor: 'system' | 'user' | null;
  actor_user_id: string | null;
  actor_email: string | null;
  approval_requested_at: Date | null;
  approval_expires_at: Date | null;
  decided_by: string | null;
  decided_by_email: string | null;
  decided_role: string | null;
  decided_ip: string | null;
  decided_at: Date | null;
  decision_comment: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

export const STEP_COLUMNS = `id, organization_id, run_id, position, step_key, action, params, risk, on_error, status, input, output, error, external,
  actor, actor_user_id, actor_email, approval_requested_at, approval_expires_at, decided_by, decided_by_email, decided_role,
  host(decided_ip) AS decided_ip, decided_at, decision_comment, started_at, finished_at, created_at`;

/** What an async step waits for. */
export type ExternalRef =
  | { kind: 'toolbox_run'; id: string }
  | { kind: 'collector_commands'; ids: string[] }
  | { kind: 'router_requests'; ids: string[] }
  | { kind: 'switch_port_requests'; ids: string[] }
  | { kind: 'config_backup_run'; id: string }
  | { kind: 'endpoint_command'; id: string }
  | { kind: 'wait'; until: string };

export interface Settings {
  two_person_rule: boolean;
  approval_ttl_minutes: number;
  updated_at: string | null;
}

export async function loadSettings(db: Db): Promise<Settings> {
  const row = (await db.query<{ two_person_rule: boolean; approval_ttl_minutes: number; updated_at: Date }>(`SELECT two_person_rule, approval_ttl_minutes, updated_at FROM playbook_settings LIMIT 1`)).rows[0];
  return row ? { two_person_rule: row.two_person_rule, approval_ttl_minutes: row.approval_ttl_minutes, updated_at: row.updated_at.toISOString() } : { two_person_rule: false, approval_ttl_minutes: 60, updated_at: null };
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export function presentPlaybook(p: PlaybookRow) {
  return {
    id: p.id,
    site_id: p.site_id,
    site_name: p.site_name,
    site_timezone: p.site_timezone,
    name: p.name,
    description: p.description,
    enabled: p.enabled,
    dry_run: p.dry_run,
    trigger: p.trigger,
    steps: p.steps,
    approval_mode: p.approval_mode,
    auto_run_set_by_email: p.auto_run_set_by_email,
    auto_run_set_at: iso(p.auto_run_set_at),
    max_runs_per_hour: p.max_runs_per_hour,
    template_key: p.template_key,
    version: p.version,
    enabled_at: iso(p.enabled_at),
    created_by: p.created_by,
    created_by_email: p.created_by_email,
    updated_by: p.updated_by,
    updated_by_email: p.updated_by_email,
    created_at: iso(p.created_at),
    updated_at: iso(p.updated_at),
  };
}

export function presentRun(r: RunRow) {
  return {
    id: r.id,
    playbook_id: r.playbook_id,
    playbook_name: r.playbook_name,
    playbook_version: r.playbook_version,
    site_id: r.site_id,
    device_id: r.device_id,
    incident_id: r.incident_id,
    event_id: r.event_id,
    trigger_kind: r.trigger_kind,
    evidence: r.evidence,
    dry_run: r.dry_run,
    approval_mode: r.approval_mode,
    status: r.status,
    status_reason: r.status_reason,
    current_position: r.current_position,
    caused_by_run_id: r.caused_by_run_id,
    chain: r.chain,
    started_by_email: r.started_by_email,
    created_at: iso(r.created_at),
    finished_at: iso(r.finished_at),
  };
}

export function presentStep(s: StepRow) {
  return {
    id: s.id,
    position: s.position,
    step_key: s.step_key,
    action: s.action,
    params: s.params,
    risk: s.risk,
    on_error: s.on_error,
    status: s.status,
    input: s.input,
    output: s.output,
    error: s.error,
    actor: s.actor,
    actor_email: s.actor_email,
    approval_requested_at: iso(s.approval_requested_at),
    approval_expires_at: iso(s.approval_expires_at),
    decided_by_email: s.decided_by_email,
    decided_at: iso(s.decided_at),
    decision_comment: s.decision_comment,
    started_at: iso(s.started_at),
    finished_at: iso(s.finished_at),
  };
}
