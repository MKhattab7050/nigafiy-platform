// Contract between the LAN Detective API (v1) and its clients.
// Types only + a few constant lists. No runtime dependencies.

export const ROLES = ['owner', 'admin', 'technician', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const DEVICE_TYPES = [
  'windows_computer',
  'linux_computer',
  'server',
  'router',
  'switch',
  'firewall',
  'printer',
  'access_point',
  'camera',
  'nas',
  'iot',
  'unknown',
] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** `unknown` = we currently have no working collector to observe it; NOT the same as offline. */
export type DeviceStatus = 'online' | 'offline' | 'unknown';
export type Severity = 'info' | 'warning' | 'critical';
export type CheckKind = 'icmp' | 'tcp' | 'dns';
export type CheckRole = 'gateway' | 'internet' | 'dns' | 'service';
export type CheckState = 'unknown' | 'ok' | 'degraded' | 'down';
export type CollectorStatus = 'pending' | 'active' | 'revoked';
export type CollectorConnection = 'never' | 'online' | 'offline';

export interface ApiError {
  error: { code: string; message: string; details?: unknown; request_id?: string };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface Me {
  user: { id: string; email: string; display_name: string; locale: 'en' | 'ar' };
  organization: { id: string; name: string; kind: string };
  role: Role;
  memberships: { organization_id: string; organization_name: string; role: Role }[];
}

export interface Site {
  id: string;
  name: string;
  timezone: string;
  discovery_interval_seconds: number;
  created_at: string;
}

export interface NetworkScope {
  id: string;
  site_id: string;
  cidr: string;
  label: string | null;
  enabled: boolean;
  authorized_by_name: string | null;
  authorized_at: string;
  last_run_finished_at: string | null;
}

export interface Collector {
  id: string;
  site_id: string;
  site_name: string;
  name: string;
  status: CollectorStatus;
  connection_state: CollectorConnection;
  hostname: string | null;
  version: string | null;
  os: string | null;
  arch: string | null;
  gateway_ip: string | null;
  spool_depth: number | null;
  last_heartbeat_at: string | null;
  enrollment_expires_at: string | null;
  created_at: string;
}

export interface CollectorCreated {
  collector: Collector;
  /** Shown exactly once. Only a hash is stored. */
  enrollment_token: string;
}

export interface Device {
  id: string;
  site_id: string;
  site_name: string;
  display_name: string | null;
  hostname: string | null;
  current_ip: string | null;
  primary_mac: string | null;
  mac_randomized: boolean;
  identity_basis: 'mac' | 'ip';
  vendor: string | null;
  device_type: DeviceType;
  type_source: 'inferred' | 'manual' | 'none';
  type_evidence: string | null;
  status: DeviceStatus;
  is_critical: boolean;
  owner: string | null;
  notes: string | null;
  discovery_sources: string[];
  first_seen_at: string;
  last_seen_at: string;
  tags: string[];
}

export interface DeviceDetail extends Device {
  ip_history: { ip: string; first_seen_at: string; last_seen_at: string }[];
  availability: { status: DeviceStatus; started_at: string; ended_at: string | null }[];
  recent_events: NetworkEvent[];
}

export interface NetworkEvent {
  id: string;
  site_id: string | null;
  site_name: string | null;
  device_id: string | null;
  check_id: string | null;
  collector_id: string | null;
  type: string;
  severity: Severity;
  title: string;
  /** Structured evidence behind the event. */
  details: Record<string, unknown>;
  source: 'collector' | 'platform';
  /** When it happened according to the observing component. */
  occurred_at: string;
  /** When the cloud platform recorded it. */
  received_at: string;
}

export interface MonitoringCheck {
  id: string;
  site_id: string;
  site_name: string;
  name: string;
  kind: CheckKind;
  role: CheckRole;
  target: string;
  port: number | null;
  interval_seconds: number;
  failure_threshold: number;
  latency_warn_ms: number | null;
  loss_warn_pct: number | null;
  enabled: boolean;
  state: CheckState;
  state_changed_at: string | null;
  last_result_at: string | null;
  last_latency_ms: number | null;
  last_loss_pct: number | null;
  last_error: string | null;
  last_resolved_target: string | null;
}

export interface CheckSeriesPoint {
  ts: string;
  samples: number;
  ok_ratio: number;
  latency_ms: number | null;
  latency_max_ms: number | null;
  loss_pct: number | null;
  jitter_ms: number | null;
}

export interface Overview {
  generated_at: string;
  devices: { total: number; online: number; offline: number; unknown: number; new_24h: number };
  collectors: { total: number; online: number };
  checks: { total: number; ok: number; degraded: number; down: number; unknown: number };
  /** null means: no samples in the window. Never a fabricated number. */
  internet: { state: CheckState | null; avg_latency_ms: number | null; avg_loss_pct: number | null; samples: number };
  gateway: { state: CheckState | null; avg_latency_ms: number | null; avg_loss_pct: number | null; samples: number };
  dns: { state: CheckState | null; avg_latency_ms: number | null; samples: number };
  availability_24h_pct: number | null;
  open_problems: number;
  recent_events: NetworkEvent[];
  problem_devices: { id: string; name: string; current_ip: string | null; status: DeviceStatus; offline_events_7d: number }[];
}

export interface NotificationChannel {
  id: string;
  kind: 'webhook';
  name: string;
  url: string;
  min_severity: Severity;
  event_types: string[] | null;
  enabled: boolean;
  created_at: string;
  last_delivery_status: string | null;
  last_delivery_at: string | null;
}

export interface AuditEntry {
  id: string;
  user_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
