// API shapes of /config-backup (apps/api/src/modules/configbackup/service.ts). Credentials are
// write-only: the API only says whether, which kind and when they were set.

export type Readiness = 'ready' | 'disabled' | 'out_of_scope' | 'no_credentials' | 'credentials_unreadable' | 'credentials_rejected' | 'host_key_changed';
export type Confidence = 'high' | 'medium' | 'low';

export interface Driver {
  id: string;
  name: string;
}

export interface Target {
  id: string;
  site_id: string;
  device_id: string | null;
  name: string;
  address: string;
  port: number;
  driver: string | null;
  detected_driver: string | null;
  detection: {
    driver?: string;
    confidence?: string;
    evidence?: { source: string; driver?: string; detail: string; weight: number }[] | null;
    prompt?: string;
    prompt_family?: string;
  } | null;
  server_version: string | null;
  credentials: {
    set: boolean;
    unreadable: boolean;
    updated_at: string | null;
    username_set: boolean;
    auth: 'password' | 'key' | 'key_and_password' | null;
    enable_secret_set: boolean;
  };
  credentials_rejected: boolean;
  host_key_sha256: string | null;
  host_key_type: string | null;
  host_key_pinned_at: string | null;
  host_key_pinned_via: 'first_use' | 'admin' | null;
  host_key_status: 'none' | 'pinned' | 'changed';
  presented_host_key: { sha256: string; type: string; seen_at: string } | null;
  enabled: boolean;
  schedule: 'daily' | 'off';
  schedule_hour: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_changed_at: string | null;
  last_status: 'never' | 'ok' | 'failed';
  last_error: string | null;
  last_error_kind: string | null;
  created_at: string;
  updated_at: string;
  in_scope: boolean;
  version_count: number;
  latest_version_id: string | null;
  pending_run_id: string | null;
  device_label: string | null;
  site_timezone: string;
  vendor: { driver: string; name: string | null; source: 'manual' | 'observed'; confidence: string | null } | null;
  readiness: Readiness;
}

export interface BackupRun {
  id: string;
  trigger: 'manual' | 'scheduled';
  status: 'pending' | 'ok' | 'failed' | 'expired';
  outcome: 'first' | 'changed' | 'unchanged' | null;
  version_id: string | null;
  host_key_status: 'first_use' | 'matched' | 'changed' | null;
  error_kind: string | null;
  error: string | null;
  duration_ms: number | null;
  created_by_email: string | null;
  created_at: string;
  completed_at: string | null;
  collector_name: string | null;
}

export interface TargetDetail extends Target {
  runs: BackupRun[];
  drivers: Driver[];
}

export interface Version {
  id: string;
  target_id: string;
  number: number;
  sha256: string;
  captured_at: string;
  last_seen_at: string;
  confirmations: number;
  driver: string | null;
  added_lines: number | null;
  removed_lines: number | null;
  size_bytes: number;
  line_count: number;
  collector_name: string | null;
}

export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
  old?: number;
  new?: number;
}

export interface Diff {
  from: { id: string; number: number; captured_at: string; sha256: string };
  to: { id: string; number: number; captured_at: string; sha256: string };
  identical: boolean;
  added: number;
  removed: number;
  approximate: boolean;
  truncated: boolean;
  hunks: { old_start: number; old_lines: number; new_start: number; new_lines: number; lines: DiffLine[] }[];
}

export interface Suggestion {
  address: string;
  device_id: string | null;
  name: string | null;
  device_type: string | null;
  vendor: string | null;
  ssh: { state: 'open' | 'closed' | 'unknown'; server_version: string | null; checked_at: string | null };
  suggested_driver: { driver: string | null; confidence: Confidence | null; name: string | null; source: 'inferred'; evidence: { source: string; driver: string; detail: string; weight: number }[] };
  reasons: { source: 'observed' | 'inferred' | 'manual'; text: string }[];
}

export interface ProbeRun {
  id: string;
  site_id?: string;
  trigger: 'manual' | 'scheduled';
  status: 'pending' | 'done' | 'expired';
  address_count: number;
  open_count: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface Suggestions {
  items: Suggestion[];
  last_probe: ProbeRun | null;
  drivers: Driver[];
}

export const ERROR_KINDS = [
  'out_of_scope',
  'unreachable',
  'timeout',
  'auth_failed',
  'host_key_changed',
  'privilege',
  'unsupported_vendor',
  'command_failed',
  'output_too_large',
  'protocol',
  'invalid_argument',
  'empty_config',
  'expired',
  'internal',
] as const;
