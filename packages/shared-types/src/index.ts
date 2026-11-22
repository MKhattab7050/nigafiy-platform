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
  'mobile',
  'apple_computer',
  'media_player',
  'unknown',
] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** `unknown` = we currently have no working collector to observe it; NOT the same as offline. */
export type DeviceStatus = 'online' | 'offline' | 'unknown';
export type Severity = 'info' | 'warning' | 'critical';
export type CheckKind = 'icmp' | 'tcp' | 'dns' | 'http' | 'https' | 'tls_expiry' | 'snmp_oid';

/** http / https check settings (config of a MonitoringCheck). */
export interface HttpCheckConfig {
  path: string;
  method: 'GET' | 'HEAD';
  expect_status: { min: number; max: number };
  body_match: { mode: 'substring' | 'regex'; pattern: string; negate: boolean } | null;
  follow_redirects: boolean;
  max_redirects: number;
  /** https only. */
  tls_verify?: boolean;
  /** https only: lower-case hex SHA-256 of the leaf certificate (DER). */
  pin_sha256?: string | null;
  allow_public: boolean;
}

export interface TlsExpiryCheckConfig {
  sni: string | null;
  warn_days: number;
  critical_days: number;
  allow_public: boolean;
}

export type SnmpCheckPreset = 'cpu' | 'memory' | 'temperature' | 'link_status' | 'custom';
export type SnmpComparison = 'gt' | 'lt' | 'eq' | 'ne';

export interface SnmpOidCheckConfig {
  preset: SnmpCheckPreset;
  oid: string;
  ratio_oid: string | null;
  scale: number;
  comparison: SnmpComparison;
  warn: number | null;
  critical: number | null;
  unit: string;
}

export interface SnmpPresetEntry {
  preset: Exclude<SnmpCheckPreset, 'custom'>;
  oid: string;
  ratio_oid?: string;
  comparison: SnmpComparison;
  warn: number | null;
  critical: number | null;
  unit: string;
  note: string;
}

/** Evidence of the last sample of a watch check (what the collector observed). */
export interface CheckSampleDetails {
  status_code?: number;
  final_url?: string;
  redirects?: number;
  body_bytes?: number;
  body_matched?: boolean;
  tls_version?: string;
  cert_subject?: string;
  cert_issuer?: string;
  cert_not_before?: string;
  cert_not_after?: string;
  cert_sha256?: string;
  cert_dns_names?: string[];
  verified?: boolean;
  verify_error?: string;
  oid?: string;
  raw_value?: string;
  ratio_raw?: string;
  value_type?: string;
}
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

export type MfaRequirement = 'off' | 'admins' | 'all';

export interface Me {
  user: { id: string; email: string; display_name: string; locale: 'en' | 'ar'; mfa_enabled: boolean };
  organization: { id: string; name: string; kind: string; mfa_required: MfaRequirement };
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
  /** 4 or 6. */
  family: 4 | 6;
  /**
   * sweep: every address is probed (IPv4, IPv6 /120 or longer). neighbor: an IPv6 prefix larger than
   * /120 is never swept; the collector reads its neighbour table and echoes the all-nodes group ff02::1.
   */
  discovery_method: 'sweep' | 'neighbor';
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
  /** Server address for the install command: PUBLIC_URL when configured, else the origin the request reached. */
  server_url: string;
  server_url_source: 'configured' | 'request';
  tls_pin_sha256?: string | null;
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
  /** How sure the classification rule is (inferred types only). */
  type_confidence: 'high' | 'medium' | 'low' | null;
  /** Where the hostname came from: rdns | mdns | netbios | ssdp. */
  name_source: string | null;
  /** What the device announced about itself. */
  fingerprint: DeviceFingerprint;
  status: DeviceStatus;
  is_critical: boolean;
  /** Owner's approval: unreviewed (new), known (belongs here), unwanted (alert when it returns). */
  trust: DeviceTrust;
  trust_changed_at: string | null;
  /** No on/offline alerts for this device. */
  alerts_muted: boolean;
  /** Ping check created from this device (follows its IP), if any. */
  monitor_check_id: string | null;
  owner: string | null;
  notes: string | null;
  discovery_sources: string[];
  first_seen_at: string;
  last_seen_at: string;
  tags: string[];
}

export const DEVICE_TRUSTS = ['unreviewed', 'known', 'unwanted'] as const;
export type DeviceTrust = (typeof DEVICE_TRUSTS)[number];

export interface InsightAction {
  /** Stable code the UI localizes (review, mark_all_known, open_router, …); label is the English fallback. */
  code: string;
  label: string;
  /** link: navigate; api: POST to the endpoint (after confirmation if confirm is set); external: open in a new tab. */
  kind: 'link' | 'api' | 'external';
  href: string;
  body?: Record<string, unknown>;
  confirm?: string;
}

export interface Insight {
  id: string;
  /** Rule that produced it; with params the UI renders title and detail in the user's language. */
  code: string;
  params: Record<string, string | number>;
  severity: Severity;
  category: 'security' | 'availability' | 'performance' | 'inventory' | 'setup';
  title: string;
  detail: string;
  evidence: string[];
  actions: InsightAction[];
  /** Devices the insight is about, with how their type was worked out (e.g. suggest_monitor_infrastructure). */
  devices?: InsightDevice[];
}

export interface InsightsReport {
  generated_at: string;
  /** 0–100, from the deductions listed in score_breakdown. */
  score: number;
  score_breakdown: { code: string; reason: string; points: number }[];
  /** healthy (≥ 90) | attention (70–89) | urgent (< 70) */
  verdict: 'healthy' | 'attention' | 'urgent';
  summary: string;
  insights: Insight[];
}

export interface DeviceFingerprint {
  names?: { source: string; name: string }[];
  services?: string[];
  hints?: Record<string, string>;
  ssdp?: { server?: string; friendly_name?: string; manufacturer?: string; model?: string; device_types?: string[] };
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
  in_maintenance?: boolean;
  maintenance_window_id?: string | null;
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
  /** Settings of the watch kinds; {} for icmp / tcp / dns. */
  config: Partial<HttpCheckConfig & TlsExpiryCheckConfig & SnmpOidCheckConfig> & Record<string, unknown>;
  /** snmp_oid: the Port Detective device read. */
  snmp_target_id: string | null;
  /** Measured value of the last sample: TLS days remaining, the OID value, the HTTP status code. */
  last_value: number | null;
  last_details: CheckSampleDetails | null;
}

export interface CheckSeriesPoint {
  ts: string;
  samples: number;
  ok_ratio: number;
  latency_ms: number | null;
  latency_max_ms: number | null;
  loss_pct: number | null;
  jitter_ms: number | null;
  /** Average / min / max measured value (snmp_oid, tls_expiry, http status) in the bucket. */
  value?: number | null;
  value_min?: number | null;
  value_max?: number | null;
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
  active_incidents: Incident[];
  recent_events: NetworkEvent[];
  problem_devices: { id: string; name: string; current_ip: string | null; status: DeviceStatus; offline_events_7d: number }[];
}

export type NotificationChannelKind = 'webhook' | 'email' | 'telegram' | 'slack' | 'discord' | 'ntfy';

export interface NotificationChannel {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  /** Webhook URL, "mailto:" + recipients for email, masked target for Telegram/Slack/Discord, or ntfy topic URL. */
  url: string;
  /** Non-secret channel settings (SMTP params, Telegram chat_id, ntfy server/topic, etc.). */
  config: {
    host?: string;
    port?: number;
    security?: 'tls' | 'starttls' | 'none';
    username?: string | null;
    from?: string;
    chat_id?: string;
    message_thread_id?: number;
    server_url?: string;
    topic?: string;
  };
  min_severity: Severity;
  event_types: string[] | null;
  enabled: boolean;
  use_for_account_emails?: boolean;
  created_at: string;
  last_delivery_status: string | null;
  last_delivery_at: string | null;
  last_delivery_error?: string | null;
}

export interface NotificationEscalation {
  id: string;
  site_id: string | null;
  site_name: string | null;
  name: string;
  channel_id: string;
  channel_name: string;
  channel_kind: NotificationChannelKind;
  min_severity: Severity;
  delay_minutes: number;
  repeat_interval_minutes: number | null;
  max_repeats: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuditEntry {
  id: string;
  user_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  /**
   * Who acted: 'user' (user_email is set), 'system' (LAN Detective acted by itself; metadata.automation
   * is the automation key) or 'collector' (triggered by a collector's report).
   */
  actor: AuditActor;
}

export type AuditActor = 'user' | 'system' | 'collector';

// ───────────────────────── Phase 2 ─────────────────────────

export type IncidentKind = 'network' | 'service' | 'collector' | 'device' | 'dhcp';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
export type Confidence = 'high' | 'medium' | 'low';
export type FaultDomain =
  | 'healthy'
  | 'local_gateway'
  | 'lan_segment'
  | 'wan_isp'
  | 'wan_quality'
  | 'remote_target'
  | 'dns'
  | 'lan_quality'
  | 'service'
  | 'service_host'
  | 'device'
  | 'collector'
  | 'site_internet'
  | 'insufficient_data'
  | 'undetermined'
  // Smart checks (modules/security): a rogue / missing DHCP server, the collector's Wi-Fi link.
  | 'dhcp'
  | 'wifi';

/** One piece of evidence. `observed` = measured directly; `derived` = computed from observations. */
export interface EvidenceItem {
  label: string;
  value: string;
  basis: 'observed' | 'derived';
  source: string;
  observed_at: string | null;
}

/** Output of the deterministic Network Doctor rule engine. Never an AI guess. */
export interface Diagnosis {
  engine: string;
  rule: string;
  fault_domain: FaultDomain;
  title: string;
  summary: string;
  probable_cause: string;
  confidence: Confidence;
  confidence_reason: string;
  evidence: EvidenceItem[];
  /** Things that were checked and found healthy — what the problem is NOT. */
  ruled_out: EvidenceItem[];
  alternatives: string[];
  investigation_steps: string[];
  recommendations: string[];
  affected: { devices_offline: number; devices_total: number; checks: { id: string; name: string; role: CheckRole; state: CheckState }[] };
  related_incidents: { id: string; number: number; title: string; opened_at: string; resolved_at: string | null; resolution_note: string | null }[];
  generated_at: string;
}

export interface Incident {
  id: string;
  number: number;
  site_id: string | null;
  site_name: string | null;
  kind: IncidentKind;
  status: IncidentStatus;
  severity: Severity;
  title: string;
  fault_domain: FaultDomain | null;
  confidence: Confidence | null;
  opened_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_kind: 'auto' | 'manual' | null;
  resolution_note: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  event_count: number;
}

export interface IncidentActivity {
  id: string;
  kind: 'comment' | 'opened' | 'acknowledged' | 'assigned' | 'resolved' | 'diagnosis';
  user_name: string | null;
  body: string;
  created_at: string;
}

export interface IncidentDetail extends Incident {
  check_id: string | null;
  device_id: string | null;
  collector_id: string | null;
  diagnosis: Diagnosis | null;
  diagnosed_at: string | null;
  activity: IncidentActivity[];
  /** Replay window: every event at the site from 30 min before to 30 min after the incident. */
  timeline: (NetworkEvent & { linked: boolean; phase: 'before' | 'during' | 'after' })[];
  window: { from: string; to: string };
}

export interface Member {
  id: string;
  display_name: string;
  email: string;
  role: Role;
}

export interface DoctorReport {
  site_id: string;
  site_name: string;
  diagnosis: Diagnosis;
  active_incident: { id: string; number: number } | null;
  collectors_online: number;
  /** Smart-check diagnoses (DHCP, Wi-Fi) that need attention; healthy ones are left out. */
  smart?: Diagnosis[];
}

export interface TopologyNode {
  id: string;
  kind: 'internet' | 'gateway' | 'segment' | 'device';
  label: string;
  /** Present for device / gateway nodes that exist in the inventory. */
  device_id: string | null;
  ip: string | null;
  mac: string | null;
  vendor: string | null;
  device_type: DeviceType | null;
  status: DeviceStatus | null;
  is_critical: boolean;
  runs_collector: boolean;
  segment: string | null;
  last_seen_at: string | null;
  /** True when this device is a switch that LAN Detective reads over SNMP. */
  is_switch?: boolean;
  /** "Gi0/4 on Core switch" when a read switch saw this device on an access port. */
  attached_to?: string | null;
  /** What this MikroTik device announced about itself over MNDP (observed by a collector). */
  mndp?: {
    identity: string | null;
    platform: string | null;
    version: string | null;
    board: string | null;
    interface_name: string | null;
    heard_by: string;
    last_seen_at: string;
    evidence: string;
  };
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  /**
   * connected_to: device → switch port (forwarding table). switch_link: switch ↔ switch (LLDP, CDP or the
   * MikroTik neighbour table). wireless_client: device → router that lists it as a Wi-Fi client.
   */
  relation: 'member_of' | 'gateway_of' | 'uplink' | 'connected_to' | 'switch_link' | 'wireless_client';
  /** Port name on the switch, for connected_to and switch_link; the router interface or SSID for wireless_client. */
  port?: string;
  basis: 'observed' | 'inferred';
  confidence: Confidence;
  evidence: string;
  evidence_source: string;
  last_verified_at: string | null;
}

export interface Topology {
  site_id: string;
  generated_at: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** What this map cannot know with the data sources currently available. */
  limitations: string[];
}

export interface SnapshotDevice {
  id: string;
  name: string;
  ip: string | null;
  mac: string | null;
  device_type: DeviceType;
  status: DeviceStatus;
  first_seen_at: string;
}

export interface Snapshot {
  at: string;
  devices: { total: number; online: number; offline: number; unknown: number; items: SnapshotDevice[] };
  checks: { id: string; name: string; role: CheckRole; state: CheckState; latency_ms: number | null; loss_pct: number | null; samples: number }[];
  incidents: Incident[];
  events: NetworkEvent[];
  /** How each part of the snapshot was reconstructed. */
  method: string[];
}

export interface PeriodStats {
  from: string;
  to: string;
  devices_seen: number;
  new_devices: number;
  incidents: number;
  incident_minutes: number;
  events: Record<string, number>;
  checks: { role: CheckRole; samples: number; availability_pct: number | null; latency_ms: number | null; loss_pct: number | null }[];
}

export interface Comparison {
  a: PeriodStats;
  b: PeriodStats;
  devices_only_in_a: SnapshotDevice[];
  devices_only_in_b: SnapshotDevice[];
  incidents_a: Incident[];
  incidents_b: Incident[];
}

// ── Access control (DNS filter) ─────────────────────────────────────────────

export interface ScheduleWindow {
  days: number[];
  from: string;
  to: string;
}

export interface AccessProfile {
  id: string;
  name: string;
  blocked_categories: string[];
  blocked_domains: string[];
  allowed_domains: string[];
  schedule: ScheduleWindow[];
  paused_until: string | null;
  device_count: number;
}

export type AccessEnforcementMode = 'router_and_dns' | 'router_only' | 'dns_only' | 'none';
export type DeviceEnforcementMode = 'router_and_dns' | 'router_only' | 'dns_only' | 'unprotected';

export interface AccessEnforcementSummary {
  mode: AccessEnforcementMode;
  dns_active: boolean;
  active_router_count: number;
  online_collector_count: number;
  /** True when DNS filtering is active on a single collector host (losing that host stops DNS resolution). */
  single_point_of_failure: boolean;
  doh_bypass_queries_24h: number;
  doh_bypass_devices_24h: number;
  top_doh_domains_24h: { domain: string; count: number }[];
}

export interface AccessDevice {
  id: string;
  name: string;
  device_type: string;
  status: string;
  trust: string;
  mac: string | null;
  ip: string | null;
  profile_id: string | null;
  profile_name: string | null;
  paused_until: string | null;
  blocked_domains: string[];
  allowed_domains: string[];
  schedule: ScheduleWindow[];
  internet_off: 'paused' | 'schedule' | null;
  protected: boolean;
  queries_24h: number;
  blocked_24h: number;
  enforcement_mode: DeviceEnforcementMode;
  router_blocked: boolean;
  router_scheduled: boolean;
  doh_bypass_24h: number;
  doh_domains_24h: string[];
}

export interface AccessPage {
  categories: string[];
  settings: { enabled: boolean; blocked_categories: string[]; blocked_domains: string[]; allowed_domains: string[]; upstreams: string[] };
  profiles: AccessProfile[];
  setup: {
    collector: { id: string; name: string; hostname: string | null; online: boolean } | null;
    status: { enabled?: boolean; listening?: boolean; error?: string; lists?: Record<string, number>; list_error?: string } | null;
    dns_server_ip: string | null;
    gateway_ip: string | null;
    protected_devices: number;
    protected_within_minutes: number;
  };
  enforcement: AccessEnforcementSummary;
  devices: AccessDevice[];
}

// ── Port Detective (switch ports over SNMP) ─────────────────────────────────

/** edge: one device. shared: a few. trunk: many (inferred uplink / AP). uplink: LLDP neighbour heard. idle: up, nothing learned. */
export type PortRole = 'edge' | 'shared' | 'trunk' | 'uplink' | 'idle' | 'down';

export interface SwitchSummary {
  id: string;
  site_id: string;
  device_id: string | null;
  name: string;
  host: string;
  port: number;
  version: '2c' | '3';
  enabled: boolean;
  poll_interval_seconds: number;
  last_polled_at: string | null;
  last_ok_at: string | null;
  last_status: 'never' | 'ok' | 'error';
  last_error: string | null;
  sys_name: string | null;
  sys_descr: string | null;
  /** Tables that hit a size ceiling on the last read ("ports", "fdb"). */
  truncated: string[];
  in_scope: boolean;
  port_count: number;
  ports_up: number;
  address_count: number;
}

export type NeighborProtocol = 'lldp' | 'cdp' | 'mikrotik';

export interface PortNeighbor {
  sys_name?: string;
  port_id?: string;
  port_descr?: string;
  chassis_id?: string;
  /** Where the entry came from (absent on reads made before CDP / MikroTik support: LLDP). */
  protocol?: NeighborProtocol;
  /** Management address the neighbour advertises (CDP, MikroTik). */
  address?: string;
  platform?: string;
  version?: string;
}

/** A MikroTik device heard announcing itself over MNDP by a collector (receive-only listener). */
export interface MndpNeighbor {
  collector_id: string;
  collector_name: string;
  mac: string;
  device_id: string | null;
  device_label: string | null;
  identity: string | null;
  platform: string | null;
  version: string | null;
  board: string | null;
  interface_name: string | null;
  ipv4: string | null;
  ipv6: string | null;
  uptime_seconds: number | null;
  source_ip: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface MndpListenerStatus {
  collector_id: string;
  collector_name: string;
  connection_state: string;
  /** null until the collector reports (older collector versions never do). */
  status: {
    state: 'listening' | 'disabled' | 'bind_failed' | 'stopped';
    listen?: string;
    error?: string;
    since: string;
    received: number;
    malformed: number;
    out_of_scope: number;
    neighbors: number;
  } | null;
}

/** A neighbour a read switch reports on one of its ports (LLDP, CDP or the MikroTik table). */
export interface SwitchNeighborRow extends PortNeighbor {
  target_id: string;
  switch_name: string;
  if_index: number;
  port_name: string;
  updated_at: string;
}

export interface NeighborsReport {
  site_id: string;
  mndp_listen: boolean;
  listeners: MndpListenerStatus[];
  mndp: MndpNeighbor[];
  switch_neighbors: SwitchNeighborRow[];
}

export interface PortDevice {
  id: string;
  label: string;
  ip: string | null;
  mac: string;
  vlan: number;
  status: DeviceStatus;
  device_type: string;
}

export interface SwitchPort {
  if_index: number;
  name: string;
  descr: string | null;
  alias: string | null;
  admin_up: boolean;
  oper_up: boolean;
  speed_mbps: number;
  in_errors: number;
  out_errors: number;
  in_discards: number;
  out_discards: number;
  /** Errors / discards added since the previous read; null on the first read or after a counter reset. */
  errors_delta: number | null;
  discards_delta: number | null;
  delta_seconds: number | null;
  /** Average bits per second between the last two reads; null when it could not be derived. */
  in_bps: number | null;
  out_bps: number | null;
  mac_count: number;
  neighbors: PortNeighbor[];
  oper_changed_at: string | null;
  updated_at: string;
  role: PortRole;
  devices: PortDevice[];
  unknown_addresses: string[];
}

export interface PortHistoryPoint {
  ts: string;
  in_bps: number | null;
  out_bps: number | null;
  /** Highest read-to-read average inside the bucket (not a true peak). */
  in_max_bps: number | null;
  out_max_bps: number | null;
  errors: number;
  discards: number;
  up: boolean;
  samples: number;
}

export interface PortHistory {
  from: string;
  to: string;
  bucket_seconds: number;
  name: string;
  speed_mbps: number;
  points: PortHistoryPoint[];
}

export interface SwitchDetail extends SwitchSummary {
  ports: SwitchPort[];
}

export interface PortLocation {
  target_id: string;
  switch_name: string;
  switch_host: string;
  if_index: number;
  port_name: string;
  port_alias: string | null;
  vlan: number;
  mac_count: number;
  neighbors: PortNeighbor[];
  oper_up: boolean;
  speed_mbps: number;
  last_seen_at: string;
  role: PortRole;
  kind: 'direct' | 'shared' | 'behind';
  confidence: Confidence;
  evidence: string[];
}

export interface DevicePort {
  location: PortLocation | null;
  seen_on: { target_id: string; switch_name: string; port_name: string; mac_count: number; vlan: number }[];
  switches_read: number;
  reason: 'no_mac' | 'no_switches' | 'not_seen' | null;
}

export interface PortSearchHit {
  device: { id: string; label: string; ip: string | null; mac: string | null; status: DeviceStatus };
  location: PortLocation | null;
}

// ── IP address management ───────────────────────────────────────────────────

export type IpamRecordKind = 'static' | 'dhcp_reservation' | 'reserved';

/** An address the administrator documented. */
export interface IpamRecord {
  id: string;
  site_id: string;
  ip: string;
  kind: IpamRecordKind;
  label: string;
  mac: string | null;
  notes: string | null;
  updated_at: string;
}

/**
 * duplicate_ip: two devices reported online at one address.
 * reserved_in_use: something answers at an address documented as kept free.
 * assignment_mismatch: the device online there is not the one the address is documented for.
 * static_in_dhcp_pool: a documented static address lies inside the documented DHCP pool.
 */
export type IpamConflictKind = 'duplicate_ip' | 'reserved_in_use' | 'assignment_mismatch' | 'static_in_dhcp_pool';

export interface IpamConflict {
  ip: string;
  kind: IpamConflictKind;
  evidence: string[];
}

export type IpamFlag = 'gateway' | 'gateway_observed' | 'collector' | 'dhcp_pool';

/** One address of a subnet that is observed, documented or infrastructure. Free addresses are not listed. */
export interface IpamAddress {
  ip: string;
  /** online / offline / unknown: observed device status. documented: on record, never observed. infrastructure: flag only. */
  state: 'online' | 'offline' | 'unknown' | 'documented' | 'infrastructure';
  devices: { id: string; label: string; mac: string | null; device_type: string; status: DeviceStatus; last_seen_at: string }[];
  record: IpamRecord | null;
  flags: IpamFlag[];
  conflict: IpamConflictKind | null;
}

export interface IpamSubnetSummary {
  id: string;
  site_id: string;
  site_name: string;
  cidr: string;
  label: string | null;
  enabled: boolean;
  last_scan_at: string | null;
  vlan_id: number | null;
  gateway: { ip: string; source: 'documented' | 'observed' } | null;
  usable: number;
  online: number;
  offline: number;
  documented_only: number;
  free: number;
  conflicts: number;
}

export interface IpamSubnetDetail extends IpamSubnetSummary {
  network: string;
  broadcast: string;
  netmask: string;
  first_host: string;
  last_host: string;
  dns_servers: string[];
  dhcp: { start: string; end: string } | null;
  notes: string | null;
  addresses: IpamAddress[];
  conflict_list: IpamConflict[];
  /** Unused, undocumented addresses outside the DHCP pool — candidates for a new static address. */
  next_free: string[];
}

export interface IpamHistoryEntry {
  device_id: string;
  label: string;
  mac: string | null;
  status: DeviceStatus;
  current: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

// ── IT Toolbox ──────────────────────────────────────────────────────────────

export type ToolKind = 'ping' | 'tcp' | 'ports' | 'dns' | 'rdns' | 'traceroute';
export type ToolRunStatus = 'pending' | 'completed' | 'failed' | 'expired';

export interface ToolHop {
  n: number;
  address?: string;
  rtt_ms?: number[];
}

export interface ToolOpenPort {
  port: number;
  service: string;
  connect_ms?: number;
}

export interface ToolRun {
  id: string;
  site_id: string;
  collector_id: string;
  collector_name: string;
  tool: ToolKind;
  target: string;
  port: number | null;
  status: ToolRunStatus;
  output: Record<string, unknown> | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

// ── Phase 3 & 4: Universal Endpoint Management & Remote Administration ──────

export type EndpointStatus = 'pending' | 'active' | 'revoked';
/** Platforms the LAN Detective endpoint agent runs on. iOS/Android are not supported. */
export type EndpointPlatform = 'windows' | 'linux' | 'macos';
export type EndpointComplianceStatus = 'compliant' | 'non_compliant' | 'attention' | 'unknown';
export type EndpointCommandKind =
  | 'refresh_inventory'
  | 'kill_process'
  | 'service_action'
  | 'power_action'
  | 'notify_user'
  | 'fs_op'
  | 'rd_capture'
  | 'rd_input'
  | 'software_action'
  | 'fetch_logs'
  | 'diagnostic_command';
export type EndpointCommandStatus = 'pending' | 'delivered' | 'completed' | 'failed' | 'expired';

export type CapabilityState =
  | 'supported'
  | 'implemented'
  | 'tested'
  | 'partially_supported'
  | 'requires_permissions'
  | 'requires_external_config'
  | 'unsupported_by_os'
  | 'not_tested';

export interface EndpointCapabilityItem {
  key: string;
  category: 'inventory' | 'remote_control' | 'file_management' | 'software';
  label_en: string;
  label_ar: string;
  state: CapabilityState;
  enabled: boolean;
  reason_en: string;
  reason_ar: string;
}

export interface EndpointSecurityPosture {
  firewall_enabled?: boolean;
  antivirus_enabled?: boolean;
  disk_encrypted?: boolean;
  pending_updates?: number;
  last_update_date?: string;
  os_build?: string;
  /** The measured evidence behind the fields above (agents that report it). */
  checks?: EndpointSecurityEvidence[];
  measured_at?: string;
}

export type EndpointComplianceCheck = 'firewall' | 'antivirus' | 'disk_encryption' | 'os_updates' | 'sip' | 'gatekeeper' | 'disk_space';
/** pass / fail / warn judge one subject; unknown = could not be measured (reason given); info = context only. */
export type EndpointEvidenceState = 'pass' | 'fail' | 'warn' | 'unknown' | 'info';

/** One measured fact: which command produced which value, and when. */
export interface EndpointSecurityEvidence {
  check: EndpointComplianceCheck;
  subject: string;
  state: EndpointEvidenceState;
  value: string;
  source: string;
  measured_at: string;
  reason?: string;
  count?: number;
}

/** The API's verdict for one compliance item, with the evidence it was decided on. */
export interface EndpointComplianceItem {
  key: EndpointComplianceCheck;
  label_en: string;
  label_ar: string;
  verdict: EndpointComplianceStatus;
  reason_en: string;
  reason_ar: string;
  evidence: EndpointSecurityEvidence[];
}

export interface EndpointPolicy {
  allowed_fs_roots?: string[];
  remote_desktop_consent?: 'unattended' | 'prompt';
}

export interface RemoteFileRoot {
  name: string;
  path: string;
  label: string;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  ext: string;
  size: number;
  mode: string;
  mod_time: string;
  is_hidden: boolean;
  is_system: boolean;
}

export interface RemoteFileResponse {
  op: string;
  path?: string;
  parent_path?: string;
  roots?: RemoteFileRoot[];
  entries?: RemoteFileEntry[];
  total_size?: number;
  offset?: number;
  bytes_read?: number;
  eof?: boolean;
  data_base64?: string;
  sha256?: string;
  message?: string;
  /** An upload replaced an existing file (only with an operator-confirmed `overwrite`). */
  overwritten?: boolean;
}

export interface RemoteDesktopDisplay {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  /** The whole virtual screen (every monitor); listed last when there is more than one. */
  all?: boolean;
}

export interface RemoteDesktopFrame {
  display_index: number;
  displays: RemoteDesktopDisplay[];
  width: number;
  height: number;
  source_width: number;
  source_height: number;
  quality: number;
  scale: number;
  capture_ms: number;
  byte_length: number;
  capture_mode: string;
  /** The screen is identical to the previous frame: no image is sent, keep showing the previous one. */
  unchanged?: boolean;
  /** Absent when `unchanged`, or when the image was no longer available (`image_unavailable`). Never stored. */
  jpeg_base64?: string;
  image_unavailable?: boolean;
  captured_at: string;
}

export interface RemoteDesktopSession {
  id: string;
  started_at: string;
  operator_email: string;
  display_index: number;
  quality: number;
  scale: number;
  consent_mode: 'unattended' | 'prompt';
  recording_enabled: boolean;
  /** Fleet Pro: the session's history row (fleet_sessions.id). */
  fleet_session_id?: string;
  /** waiting_consent: the person at the computer has not answered yet; frames and input wait. */
  state?: 'waiting_consent' | 'active';
  reason?: string | null;
}

export type FleetSessionState = 'waiting_consent' | 'active' | 'ended';
export type FleetConsentResult = 'pending' | 'not_required' | 'accepted' | 'denied' | 'timeout' | 'unavailable';
export type FleetSessionEndReason = 'operator' | 'user' | 'consent_denied' | 'consent_timeout' | 'consent_unavailable' | 'replaced' | 'revoked' | 'expired';

/** One remote support session (fleet_sessions). Frames are never stored: only relay counts. */
export interface FleetSession {
  id: string;
  endpoint_id: string;
  endpoint_name?: string;
  public_id: string;
  operator_email: string | null;
  reason: string | null;
  state: FleetSessionState;
  consent_mode: 'unattended' | 'prompt';
  consent_result: FleetConsentResult;
  consent_error: string | null;
  consent_decided_at: string | null;
  banner_state: 'pending' | 'shown' | 'unavailable' | 'not_supported';
  banner_error: string | null;
  transport: 'http' | 'ws';
  stream_connected_at: string | null;
  desktop_mode: string | null;
  display_index: number;
  quality: number | null;
  scale: number | null;
  frames_relayed: number;
  bytes_relayed: number;
  clipboard_to_remote: number;
  clipboard_from_remote: number;
  started_at: string;
  accepted_at: string | null;
  ended_at: string | null;
  end_reason: FleetSessionEndReason | null;
  ended_by_email: string | null;
  source: 'live' | 'audit_backfill';
}

/** GET /endpoints/:id/remote-desktop/session */
export interface FleetSessionStatus {
  session: RemoteDesktopSession | null;
  fleet_session: FleetSession | null;
  /** The agent's live socket is connected (on any API instance). */
  stream_connected: boolean;
}

export interface EndpointDisk {
  mount: string;
  filesystem?: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  used_pct: number;
}

export interface EndpointInterface {
  name: string;
  mac?: string;
  addresses: string[];
}

export interface EndpointProcess {
  pid: number;
  name: string;
  cpu_pct?: number;
  mem_mb: number;
  user?: string;
  command?: string;
}

export interface EndpointService {
  name: string;
  display_name: string;
  state: 'running' | 'stopped' | 'other';
  start_mode?: 'auto' | 'manual' | 'disabled' | 'other';
}

export interface EndpointSoftware {
  name: string;
  version?: string;
  publisher?: string;
  install_date?: string;
}

export interface EndpointConnection {
  proto: 'tcp' | 'udp';
  local_address: string;
  local_port: number;
  remote_address?: string;
  remote_port?: number;
  state: string;
  pid?: number;
  process_name?: string;
}

export interface EndpointSummary {
  id: string;
  site_id: string;
  site_name: string;
  device_id: string | null;
  name: string;
  platform: EndpointPlatform;
  status: EndpointStatus;
  connection_state: 'never' | 'online' | 'offline';
  compliance_status: EndpointComplianceStatus;
  compliance_reasons: string[];
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  agent_version: string | null;
  hostname: string | null;
  os: string | null;
  os_version: string | null;
  arch: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  ram_total_mb: number | null;
  uptime_seconds: number | null;
  logged_in_users: string[];
  primary_ip: string | null;
  primary_mac: string | null;
  cpu_pct: number | null;
  ram_used_mb: number | null;
  ram_pct: number | null;
  disk_used_pct: number | null;
  last_heartbeat_at: string | null;
  inventory_updated_at: string | null;
  enrollment_expires_at: string | null;
  created_at: string;
}

export interface EndpointCreated {
  endpoint: EndpointSummary;
  enrollment_token: string;
  /** Server address for the agent's -server flag: PUBLIC_URL when configured, else the origin the request reached. */
  server_url: string;
  server_url_source: 'configured' | 'request';
  tls_pin_sha256: string | null;
}

export interface EndpointCommand {
  id: string;
  endpoint_id: string;
  kind: EndpointCommandKind;
  payload: Record<string, unknown>;
  status: EndpointCommandStatus;
  output: string | null;
  error: string | null;
  result_data?: Record<string, unknown> | null;
  created_by_name: string | null;
  created_at: string;
  delivered_at: string | null;
  completed_at: string | null;
}

export interface EndpointDetail extends EndpointSummary {
  security: EndpointSecurityPosture;
  compliance_items: EndpointComplianceItem[];
  policy: EndpointPolicy;
  rd_session: RemoteDesktopSession | null;
  last_rd_frame: RemoteDesktopFrame | null;
  capabilities: EndpointCapabilityItem[];
  disks: EndpointDisk[];
  interfaces: EndpointInterface[];
  processes: EndpointProcess[];
  services: EndpointService[];
  software: EndpointSoftware[];
  connections: EndpointConnection[];
  commands: EndpointCommand[];
}

export interface EndpointSeriesPoint {
  ts: string;
  cpu_pct: number | null;
  ram_pct: number | null;
  disk_used_pct: number | null;
  samples: number;
}



// ───────────────────────── Smart defaults / automation ─────────────────────────

/** Facts LAN Detective worked out itself are labelled as such, with how sure it is and why. */
export interface InferredFact {
  inferred: true;
  confidence: Confidence;
  evidence: string[];
}

export type AutomationSource = 'default' | 'org' | 'site';

export interface AutomationOverride {
  enabled: boolean;
  config: Record<string, unknown>;
  updated_at: string;
  updated_by: string | null;
}

export interface AutomationItem {
  key: string;
  /** Module that performs or proposes it. */
  owner: string;
  /** 'act': does something by itself; 'suggest': only proposes, the user decides. */
  kind: 'act' | 'suggest';
  description_key: string;
  description: string;
  default_enabled: boolean;
  /** Effective state for the requested scope (site when site_id was given, else organization). */
  enabled: boolean;
  source: AutomationSource;
  config: Record<string, unknown>;
  default_config: Record<string, unknown>;
  org_override: AutomationOverride | null;
  site_override: AutomationOverride | null;
  /** From the system audit entries of this automation (for the site when site_id was given), last 30 days. */
  last_effect: { count: number; last_at: string | null; window_days: number };
}

export interface AutomationList {
  site_id: string | null;
  items: AutomationItem[];
}

export interface ScopeSuggestionSource {
  kind: 'interface' | 'gateway';
  collector_id: string;
  collector_name: string;
  /** Interface name for kind 'interface'; null for 'gateway'. */
  interface: string | null;
  /** The address as the collector reported it ("192.168.1.20/16", or the gateway "192.168.1.1"). */
  reported: string;
}

export interface ScopeSuggestion {
  /** Ready to send to POST /sites/:id/scopes (after the user confirms authorization). */
  cidr: string;
  /** The network exactly as reported, when it differs from `cidr` (narrowed) — else null. */
  reported_cidr: string | null;
  narrowed: boolean;
  /** false: the collector reports this exact network on its interface. true: worked out (narrowed, or from the gateway). */
  inferred: boolean;
  confidence: Confidence;
  evidence: string[];
  sources: ScopeSuggestionSource[];
}

export interface ScopeSuggestions {
  site_id: string;
  items: ScopeSuggestion[];
}

export interface DeviceMonitorResult {
  id: string;
  /** created: a new check; exists: the device already had one; not_found / no_address: nothing done. */
  status: 'created' | 'exists' | 'not_found' | 'no_address';
  check_id: string | null;
  error: { code: string; message: string } | null;
}

export interface DeviceMonitorBulk {
  created: number;
  results: DeviceMonitorResult[];
}

export interface DefaultChecksRestored {
  site_id: string;
  /** Names of the starter checks that were missing and are now created again ([] when all were there). */
  created: string[];
  /** Names of the starter checks that already existed. */
  existing: string[];
}

export interface InsightDevice {
  device_id: string;
  label: string;
  ip: string | null;
  device_type: DeviceType;
  type_confidence: Confidence;
  /** The device type was inferred by LAN Detective (never set by a person). */
  inferred: true;
  evidence: string | null;
}

export interface SwitchCandidateReason {
  kind: 'classified' | 'lldp_neighbor';
  evidence: string;
}

export interface SwitchCandidate {
  device_id: string;
  label: string;
  ip: string | null;
  mac: string | null;
  device_type: DeviceType;
  type_source: 'none' | 'inferred' | 'manual';
  type_confidence: Confidence | null;
  /** Whether its address is inside an authorized scope (adding it as a switch requires that). */
  in_scope: boolean;
  /** Always true: being a switch is a guess until SNMP answers. */
  inferred: true;
  reasons: SwitchCandidateReason[];
}

export interface EndpointEnrollmentSuggestion {
  device_id: string;
  site_id: string;
  suggested_name: string;
  suggested_platform: EndpointPlatform;
  /** inferred: from the device classification; default: nothing known, so the product default (windows). */
  platform_source: 'inferred' | 'default';
  platform_confidence: Confidence | null;
  platform_evidence: string[];
  /** Already enrolled / pending endpoint for this device, if any. */
  existing_endpoint_id: string | null;
  server_url: string;
  server_url_source: 'configured' | 'request';
  tls_pin_sha256: string | null;
}

// ───────────────────────── Team Accounts, MFA & Invitations ─────────────────────────

export type MemberStatus = 'active' | 'deactivated';
export type AccountMailOutcome = 'sent' | 'not_configured' | 'failed';

export interface AuthOptions {
  allow_registration: boolean;
  account_mail_configured: boolean;
  /** At least one organization on this server has an enabled SSO identity provider. */
  sso_available: boolean;
}

// ── Enterprise single sign-on (docs/features/sso.md) ──
export type IdentityProviderKind = 'oidc' | 'saml';
export type SsoAssignableRole = Exclude<Role, 'owner'>;

export interface IdentityProviderRoleMapping {
  /** A value of the role claim / attribute (exact, case-sensitive). */
  value: string;
  role: SsoAssignableRole;
}

/** An organization's identity provider as administrators see it. The OIDC client secret is write-only. */
export interface IdentityProvider {
  id: string;
  kind: IdentityProviderKind;
  name: string;
  enabled: boolean;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_set: boolean;
  oidc_scopes: string;
  saml_entry_point: string | null;
  saml_idp_entity_id: string | null;
  saml_idp_cert: string | null;
  saml_request_binding: 'redirect' | 'post';
  email_attribute: string;
  name_attribute: string | null;
  role_attribute: string | null;
  role_mapping: IdentityProviderRoleMapping[];
  allowed_email_domains: string[];
  jit_provisioning: boolean;
  default_role: SsoAssignableRole;
  trust_idp_mfa: boolean;
  linked_users: number;
  created_at: string;
  updated_at: string;
  /** What to configure at the identity provider for this Nigafiy server. */
  service_provider: {
    oidc_redirect_uri: string;
    saml_acs_url: string;
    saml_entity_id: string;
    saml_metadata_url: string;
  };
}

/** Providers that accept a typed email address (sign-in page). */
export interface SsoDiscoverResponse {
  providers: Array<{ id: string; name: string; kind: IdentityProviderKind }>;
}

export type LoginResponse =
  | { ok: true }
  | { ok: false; mfa_required: true; mfa_token: string }
  | { ok: false; mfa_setup_required: true; mfa_token: string };

export interface MfaSetupResponse {
  secret: string;
  otpauth_uri: string;
}

export interface MfaConfirmResponse {
  ok: true;
  recovery_codes: string[];
}

export interface TeamMember {
  id: string;
  display_name: string;
  email: string;
  role: Role;
  status: MemberStatus;
  mfa_enabled: boolean;
  last_login_at: string | null;
  joined_at: string;
  deactivated_at: string | null;
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: Role;
  invited_by_name: string | null;
  created_at: string;
  expires_at: string;
}

export interface TeamOverview {
  members: TeamMember[];
  invitations: TeamInvitation[];
  mfa_required: MfaRequirement;
  account_mail_configured: boolean;
}

export interface InvitationCreated {
  invitation: TeamInvitation;
  mail_outcome: AccountMailOutcome;
  invite_url: string;
  token: string;
}

export interface InvitationPreview {
  email: string;
  role: Role;
  organization_name: string;
  invited_by_name: string | null;
  expires_at: string;
  existing_user: boolean;
}

export interface PasswordResetIssued {
  mail_outcome: AccountMailOutcome;
  reset_url: string;
  token: string;
  expires_at: string;
}

// ───────────────────────── Maintenance Windows ─────────────────────────

export interface MaintenanceOccurrence {
  start: string;
  end: string;
}

export interface MaintenanceWindow {
  id: string;
  site_id: string | null;
  site_name: string | null;
  reason: string;
  timezone: string;
  starts_local: string;
  ends_local: string;
  weekdays: number[] | null;
  recur_until: string | null;
  target_all: boolean;
  device_ids: string[];
  check_ids: string[];
  collector_ids: string[];
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  active: boolean;
  current_occurrence: MaintenanceOccurrence | null;
  next_occurrence: MaintenanceOccurrence | null;
}

export interface MaintenanceRun {
  id: string;
  window_id: string | null;
  site_id: string | null;
  site_name: string | null;
  reason: string;
  occurrence_start: string;
  occurrence_end: string;
  scope: {
    target_all: boolean;
    device_ids: string[];
    check_ids: string[];
    collector_ids: string[];
  };
  started_at: string;
  ended_at: string | null;
}

export interface MaintenanceList {
  items: MaintenanceWindow[];
  active_runs: MaintenanceRun[];
}

// ───────────────────────── Global Search & Reports ─────────────────────────

export type SearchHitKind = 'device' | 'endpoint' | 'incident' | 'switch' | 'subnet' | 'scope' | 'router' | 'knowledge';

export interface SearchHit {
  kind: SearchHitKind;
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  href: string;
  site_id: string | null;
  site_name: string | null;
}

export interface SearchResponse {
  query: string;
  items: SearchHit[];
}

export interface SummaryReport {
  generated_at: string;
  days: number;
  from: string;
  to: string;
  period: { days: number; from: string; to: string };
  organization: { id: string; name: string };
  site: { id: string; name: string; timezone: string } | null;
  sites_count: number;
  devices: {
    total: number;
    online: number;
    offline: number;
    unknown: number;
    critical: number;
    critical_offline: number;
    new_in_window: number;
    by_trust: { known: number; unreviewed: number; unwanted: number };
    by_type: { device_type: DeviceType; count: number }[];
  };
  collectors: {
    total: number;
    online: number;
    offline: number;
  };
  checks: {
    total: number;
    ok: number;
    degraded: number;
    down: number;
    unknown: number;
    availability_pct: number | null;
    avg_latency_ms: number | null;
    avg_loss_pct: number | null;
    by_role: {
      role: CheckRole;
      total: number;
      ok: number;
      degraded: number;
      down: number;
      samples: number;
      availability_pct: number | null;
      avg_latency_ms: number | null;
      avg_loss_pct: number | null;
    }[];
  };
  incidents: {
    total: number;
    total_in_window: number;
    active: number;
    resolved: number;
    resolved_in_window: number;
    mttr_minutes: number | null;
    by_severity: { critical: number; warning: number; info: number };
  };
  endpoints: {
    total: number;
    online: number;
    offline: number;
    compliant: number;
    non_compliant: number;
    attention: number;
    unknown: number;
    by_compliance: {
      compliant: number;
      non_compliant: number;
      attention: number;
      unknown: number;
    };
  };
  ipam: {
    subnets: number;
    usable_addresses: number;
    online_addresses: number;
    documented_addresses: number;
    utilization_pct: number | null;
    conflicts: number;
  };
  switches: {
    total: number;
    ok: number;
    error: number;
    ports_total: number;
    ports_up: number;
  };
  routers: {
    total: number;
    ok: number;
    active_blocks: number;
    clients: number;
  };
}

// ── Knowledge memory (incident resolution knowledge base + runbooks) ────────

export type KnowledgeStatus = 'candidate' | 'draft' | 'published' | 'discarded';
export type KnowledgeSource = 'incident' | 'manual';
export type KnowledgeKind = 'article' | 'runbook';

/** One knowledge article or runbook as listed. Text fields are plain text with minimal markdown. */
export interface KnowledgeEntry {
  id: string;
  status: KnowledgeStatus;
  source: KnowledgeSource;
  kind: KnowledgeKind;
  title: string;
  symptoms: string;
  cause: string;
  /** 'doctor': the Network Doctor's inferred probable cause, not yet confirmed by a person. */
  cause_source: 'doctor' | 'manual';
  fix_steps: string;
  tags: string[];
  rule_ids: string[];
  incident_kinds: IncidentKind[];
  event_types: string[];
  device_types: string[];
  vendors: string[];
  site_id: string | null;
  site_name: string | null;
  device_id: string | null;
  device_name: string | null;
  check_id: string | null;
  check_name: string | null;
  incident_id: string | null;
  incident_number: number | null;
  fault_domain: string | null;
  diagnosis_summary: string | null;
  diagnosis_confidence: Confidence | null;
  incident_duration_seconds: number | null;
  edited: boolean;
  revision: number;
  helpful: number;
  not_helpful: number;
  uses: number;
  /** The caller's own vote: true = helped, false = did not help, null = no vote. */
  my_vote: boolean | null;
  created_by_name: string | null;
  updated_by_name: string | null;
  published_by_name: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeRevision {
  id: string;
  revision: number;
  action: 'captured' | 'refreshed' | 'created' | 'edited' | 'published' | 'unpublished' | 'discarded' | 'restored';
  user_name: string | null;
  created_at: string;
  snapshot: Pick<KnowledgeEntry, 'title' | 'symptoms' | 'cause' | 'cause_source' | 'fix_steps' | 'kind' | 'tags' | 'rule_ids' | 'incident_kinds' | 'event_types' | 'device_types' | 'vendors'>;
}

export interface KnowledgeUse {
  incident_id: string;
  incident_number: number;
  incident_title: string;
  user_name: string | null;
  created_at: string;
}

export interface KnowledgeDetail extends KnowledgeEntry {
  revisions: KnowledgeRevision[];
  used_on: KnowledgeUse[];
}

export interface KnowledgeList extends Paginated<KnowledgeEntry> {
  counts: { candidate: number; draft: number; published: number; discarded: number };
}

export type KnowledgeReasonCode =
  | 'rule'
  | 'fault_domain'
  | 'incident_kind'
  | 'event_type'
  | 'device'
  | 'check'
  | 'device_type'
  | 'vendor'
  | 'site'
  | 'text'
  | 'recent'
  | 'votes'
  | 'used';

/** Why a suggestion ranked where it did: every point of the score is explained. */
export interface KnowledgeReason {
  code: KnowledgeReasonCode;
  /** The matched value(s), e.g. the rule id, the vendor, the overlapping event types. */
  detail: string | null;
  points: number;
}

export interface KnowledgeSuggestion {
  entry: KnowledgeEntry;
  score: number;
  reasons: KnowledgeReason[];
}

export interface KnowledgeSuggestResponse {
  /** What the suggestions were matched against (all observed or recorded values). */
  context: {
    incident_id: string | null;
    device_id: string | null;
    site_id: string | null;
    rule_ids: string[];
    fault_domain: string | null;
    incident_kind: IncidentKind | null;
    event_types: string[];
    device_type: string | null;
    vendor: string | null;
    check_id: string | null;
  };
  items: KnowledgeSuggestion[];
}

// ── Digital twin (failure impact simulation) and multi-site / multi-organization portfolio ──

export type ImpactNodeKind = 'internet' | 'gateway' | 'segment' | 'device' | 'switch' | 'collector';

export interface ImpactGraphNode {
  /** Same id as the topology node (dev:…, gw:…, seg:…, internet); collectors are col:<id>. */
  id: string;
  kind: ImpactNodeKind;
  label: string;
  device_id: string | null;
  collector_id: string | null;
  ip: string | null;
  segment: string | null;
  status: DeviceStatus | null;
  is_critical: boolean;
  /** Switch ports that carry a known link (for "fail this port"). */
  ports?: string[];
}

export interface ImpactGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: TopologyEdge['relation'] | 'wireless_client' | 'runs_on' | 'collector_in';
  port?: string;
  basis: 'observed' | 'inferred';
  /** Normalized for impact: observed keeps its confidence, inferred is at most medium. */
  confidence: Confidence;
  evidence: string;
  evidence_source: string;
  /** The device's place in the layer-2 fabric was not observed (it is only known to be in this segment). */
  unknown_attachment: boolean;
  segment: string | null;
  last_verified_at: string | null;
}

export interface ImpactGraph {
  site_id: string;
  generated_at: string;
  nodes: ImpactGraphNode[];
  edges: ImpactGraphEdge[];
  limitations: string[];
}

export type ImpactFailure =
  | { type: 'node'; id: string }
  | { type: 'device'; id: string }
  | { type: 'collector'; id: string }
  | { type: 'port'; id: string; port: string }
  | { type: 'link'; id: string }
  | { type: 'site' };

export interface ImpactPathStep {
  edge_id: string;
  from: string;
  to: string;
  from_label: string;
  to_label: string;
  relation: ImpactGraphEdge['relation'];
  basis: 'observed' | 'inferred';
  confidence: Confidence;
  evidence: string;
  evidence_source: string;
  /** This step relies on an attachment that was not observed. */
  uncertain: boolean;
}

/** failed: selected; cut_off: reaches neither the internet nor the site core; internet_lost: LAN still works; attachment_unknown: may be affected. */
export type DeviceImpactStatus = 'failed' | 'cut_off' | 'internet_lost' | 'attachment_unknown';

export interface ImpactedDevice {
  node_id: string;
  device_id: string | null;
  label: string;
  ip: string | null;
  kind: ImpactNodeKind;
  is_critical: boolean;
  status: DeviceImpactStatus;
  confidence: Confidence;
  reason: string;
  path: ImpactPathStep[];
}

export interface ImpactedCheck {
  check_id: string;
  name: string;
  role: CheckRole;
  kind: CheckKind;
  target: string;
  status: 'down' | 'may_go_down';
  confidence: Confidence;
  reason: string;
  /** How the check's target was tied to the graph. */
  target_binding: string | null;
  path: ImpactPathStep[];
}

export interface ImpactedEndpoint {
  endpoint_id: string;
  name: string;
  device_id: string | null;
  status: 'unreachable' | 'internet_lost' | 'attachment_unknown';
  confidence: Confidence;
  reason: string;
}

export interface ImpactedCollector {
  collector_id: string;
  name: string;
  status: 'failed' | 'cut_off' | 'internet_lost';
  reason: string;
}

export interface SiteImpact {
  site_id: string;
  name: string;
  dark: boolean;
  internet: 'lost' | 'kept' | 'unknown';
  monitoring: 'blind' | 'kept' | 'none';
  reasons: string[];
}

export interface ImpactResult {
  site_id: string;
  generated_at: string;
  failures: { failure: ImpactFailure; label: string }[];
  devices: ImpactedDevice[];
  checks: ImpactedCheck[];
  endpoints: ImpactedEndpoint[];
  collectors: ImpactedCollector[];
  sites: SiteImpact[];
  summary: {
    devices_failed: number;
    devices_cut_off: number;
    devices_internet_lost: number;
    devices_attachment_unknown: number;
    checks_down: number;
    checks_may_go_down: number;
    endpoints_unreachable: number;
    endpoints_attachment_unknown: number;
    sites_dark: number;
  };
  /** Node / edge ids to highlight on the network map. */
  highlight: { failed: string[]; impacted: string[]; uncertain: string[]; edges: string[] };
  limitations: string[];
}

export interface SpofEntry {
  target: ImpactFailure;
  node_id: string | null;
  edge_id: string | null;
  label: string;
  kind: ImpactNodeKind | 'link';
  /** devices impacted + checks down + endpoints unreachable. */
  blast_radius: number;
  devices_impacted: number;
  critical_devices_impacted: number;
  checks_down: number;
  endpoints_unreachable: number;
  site_dark: boolean;
  attachment_unknown: number;
  confidence: Confidence;
  evidence: string[];
}

export interface SpofReport {
  site_id: string;
  generated_at: string;
  items: SpofEntry[];
  limitations: string[];
}

export interface PortfolioKpis {
  health: { score: number; verdict: InsightsReport['verdict'] } | null;
  incidents: { critical: number; warning: number; info: number; total: number };
  devices: { total: number; online: number; offline: number; unknown: number; unreviewed: number };
  collectors: { total: number; online: number; offline: number; never: number; last_heartbeat_at: string | null };
  endpoints: { total: number; online: number; compliant: number; non_compliant: number; attention: number; unknown: number };
  checks: { total: number; ok: number; degraded: number; down: number; unknown: number; last_failure: { check_id: string; name: string; at: string } | null };
}

export interface PortfolioSite extends PortfolioKpis {
  site_id: string;
  name: string;
  timezone: string;
}

export interface PortfolioSites {
  organization_id: string;
  generated_at: string;
  items: PortfolioSite[];
}

export interface PortfolioOrganization extends PortfolioKpis {
  organization_id: string;
  name: string;
  kind: string;
  role: Role;
  current: boolean;
  /** Set when the organization's policy keeps its data closed to this session (no KPIs are returned). */
  locked: 'mfa_required' | null;
  sites: number;
}

export interface PortfolioOrganizations {
  generated_at: string;
  items: PortfolioOrganization[];
}

/** GET /system/tls: what the HTTPS listener serves and the fingerprint collectors / agents pin. */
export interface TlsStatus {
  /** auto: built-in LAN TLS (local CA); files: TLS_CERT_FILE / TLS_KEY_FILE; off: no HTTPS listener. */
  mode: 'auto' | 'files' | 'off';
  https_port: number | null;
  https_host: string | null;
  /** Colon-separated SHA-256: the local CA (auto) or the configured certificate / TLS_PIN_SHA256 (files). */
  pin_sha256: string | null;
  pin_kind: 'ca' | 'leaf' | null;
  leaf_not_after: string | null;
  ca_not_after: string | null;
  dns_names: string[];
  ip_addresses: string[];
  last_renewed_at: string | null;
}
