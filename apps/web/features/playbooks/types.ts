// API shapes of /playbooks, /playbook-runs and /playbook-approvals (apps/api/src/modules/playbooks).

export type ActionKey =
  | 'notify'
  | 'run_tool'
  | 'run_checks'
  | 'run_discovery'
  | 'wake_device'
  | 'set_trust'
  | 'dns_pause'
  | 'dns_resume'
  | 'router_block'
  | 'router_unblock'
  | 'router_rate_limit'
  | 'router_wifi'
  | 'router_reboot'
  | 'switch_port_quarantine'
  | 'switch_port_disable'
  | 'config_backup'
  | 'endpoint_command'
  | 'incident_comment'
  | 'incident_acknowledge'
  | 'wait'
  | 'condition'
  | 'approval';

export type Severity = 'info' | 'warning' | 'critical';

export interface StepDef {
  key?: string;
  label?: string;
  action: ActionKey;
  on_error?: 'stop' | 'continue';
  params: Record<string, unknown>;
}

export type Trigger =
  | {
      kind: 'event';
      event_types: string[];
      filters?: { severities?: Severity[]; device_trust?: string[]; device_types?: string[]; critical_only?: boolean; check_ids?: string[]; check_roles?: string[] };
    }
  | { kind: 'incident'; on: 'opened' | 'resolved'; incident_kinds?: string[]; severities?: Severity[] }
  | { kind: 'schedule'; every_minutes?: number; daily_at?: string; timezone?: string }
  | { kind: 'manual' };

export type ApprovalMode = 'always_ask' | 'run_automatically';

export interface Playbook {
  id: string;
  site_id: string | null;
  site_name: string | null;
  name: string;
  description: string;
  enabled: boolean;
  dry_run: boolean;
  trigger: Trigger;
  steps: (StepDef & { key: string })[];
  approval_mode: ApprovalMode;
  auto_run_set_by_email: string | null;
  auto_run_set_at: string | null;
  max_runs_per_hour: number;
  template_key: string | null;
  version: number;
  enabled_at: string | null;
  created_by_email: string | null;
  updated_by_email: string | null;
  updated_at: string;
  next_run_at?: string | null;
  active_runs?: number;
  awaiting_approval?: number;
  last_run_status?: RunStatus | null;
  last_run_at?: string | null;
}

export interface Template {
  key: string;
  name: string;
  description: string;
  trigger: Trigger;
  steps: StepDef[];
}

export interface Catalog {
  actions: { key: ActionKey; needs_device: boolean; needs_incident: boolean; always_approve: boolean; default_risk: 'low' | 'disruptive' }[];
  trigger_event_types: string[];
  incident_kinds: string[];
  condition_tests: string[];
  tool_kinds: string[];
  endpoint_command_kinds: string[];
  templates: Template[];
  limits: Record<string, number>;
}

export type RunStatus = 'queued' | 'running' | 'waiting' | 'awaiting_approval' | 'succeeded' | 'stopped' | 'failed' | 'rejected' | 'expired' | 'cancelled' | 'skipped';
export type StepStatus = 'pending' | 'awaiting_approval' | 'approved' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'rejected' | 'expired' | 'previewed' | 'cancelled';

export interface Rights {
  can_approve: boolean;
  can_reject: boolean;
  self_approval: 'only_administrator' | null;
  reason: string | null;
}

export interface RunStep {
  id: string;
  position: number;
  step_key: string;
  action: ActionKey;
  params: Record<string, unknown>;
  risk: 'low' | 'disruptive';
  on_error: 'stop' | 'continue';
  status: StepStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  actor: 'system' | 'user' | null;
  actor_email: string | null;
  approval_requested_at: string | null;
  approval_expires_at: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  started_at: string | null;
  finished_at: string | null;
  needs_approval?: boolean;
  rights?: Rights;
}

export interface Run {
  id: string;
  playbook_id: string | null;
  playbook_name: string;
  playbook_version: number;
  site_id: string | null;
  device_id: string | null;
  incident_id: string | null;
  event_id: string | null;
  trigger_kind: 'event' | 'incident' | 'schedule' | 'manual';
  evidence: Record<string, unknown>;
  dry_run: boolean;
  approval_mode: ApprovalMode;
  status: RunStatus;
  status_reason: string | null;
  current_position: number;
  caused_by_run_id: string | null;
  started_by_email: string | null;
  created_at: string;
  finished_at: string | null;
  steps_total?: number;
  steps_done?: number;
}

export interface RunDetail extends Run {
  site_name: string | null;
  device_label: string | null;
  next_run_at: string | null;
  can_cancel: boolean;
  devices: { id: string; label: string }[];
  steps: RunStep[];
}

export interface Approval {
  run: Run;
  step: RunStep;
  steps_total: number;
  rights: Rights;
}

export interface PlaybookSettings {
  two_person_rule: boolean;
  approval_ttl_minutes: number;
  updated_at: string | null;
  approvers: number;
}

export const ACTIVE: RunStatus[] = ['queued', 'running', 'waiting', 'awaiting_approval'];
