// API shapes of /security (apps/api/src/modules/security/routes.ts). Every text a device or a
// nearby network said about itself (SSIDs, page titles, UPnP descriptions, server headers) is
// untrusted: it is rendered as plain text only.

export type CheckKind = 'rogue_dhcp' | 'upnp' | 'wifi' | 'banners' | 'dhcp_fingerprints';
export type RunnableCheck = Exclude<CheckKind, 'dhcp_fingerprints'>;
export const CHECKS: CheckKind[] = ['rogue_dhcp', 'upnp', 'wifi', 'banners', 'dhcp_fingerprints'];
export const RUNNABLE: RunnableCheck[] = ['rogue_dhcp', 'upnp', 'wifi', 'banners'];

export type SmartErrorKind = 'listen_failed' | 'no_interface' | 'not_supported' | 'command_failed' | 'not_found' | 'timeout' | 'protocol' | 'internal';
export type FindingSeverity = 'info' | 'warning' | 'critical';
export type FindingCategory = 'dhcp' | 'upnp' | 'wifi';
export type ExpectedKind = 'dhcp_server' | 'wifi_bssid' | 'upnp_mapping';

export interface CheckRun {
  collector_id: string;
  collector_name: string;
  check_kind: CheckKind;
  trigger: 'scheduled' | 'manual';
  ok: boolean;
  error_kind: SmartErrorKind | null;
  error: string | null;
  duration_ms: number | null;
  summary: Record<string, unknown>;
  ran_at: string;
}

export interface Finding {
  id: string;
  site_id: string;
  category: FindingCategory;
  kind: string;
  key: string;
  severity: FindingSeverity;
  title: string;
  details: Record<string, unknown>;
  device_id: string | null;
  device_name: string | null;
  status: 'open' | 'resolved';
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolution: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

export interface DhcpServer {
  id: string;
  server_id: string;
  source_ip: string | null;
  server_mac: string | null;
  offered_ip: string | null;
  subnet_mask: string | null;
  routers: string[];
  dns_servers: string[];
  lease_seconds: number | null;
  domain: string | null;
  interfaces: unknown;
  expected: 'admin' | 'gateway' | 'baseline' | null;
  first_seen_at: string;
  last_offer_at: string | null;
  missed_probes: number;
  rogue_open: boolean;
  clients_choosing: number;
  last_client_choice_at: string | null;
  approval_id: string | null;
}

export interface UpnpMapping {
  id: string;
  protocol: 'TCP' | 'UDP';
  external_port: number;
  remote_host: string;
  internal_client: string;
  internal_port: number;
  description: string | null;
  enabled: boolean;
  lease_seconds: number | null;
  device_id: string | null;
  device_name: string | null;
  risk: FindingSeverity;
  risk_reason: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface UpnpGateway {
  id: string;
  address: string;
  friendly_name: string | null;
  manufacturer: string | null;
  model: string | null;
  service_type: string | null;
  external_ip: string | null;
  mappings_truncated: boolean;
  last_error: string | null;
  first_seen_at: string;
  last_seen_at: string;
  collector_name: string | null;
  mappings: UpnpMapping[];
}

export interface WifiNetwork {
  bssid: string;
  ssid: string;
  channel: number | null;
  band: string | null;
  frequency_mhz: number | null;
  signal_pct: number | null;
  rssi_dbm: number | null;
  security: string | null;
  auth: string | null;
  cipher: string | null;
  last_seen_at: string;
}

export interface WifiLinkRow {
  collector_id: string;
  collector_name: string;
  platform: string;
  interface: string | null;
  connected: boolean;
  ssid: string | null;
  bssid: string | null;
  band: string | null;
  channel: number | null;
  frequency_mhz: number | null;
  signal_pct: number | null;
  rssi_dbm: number | null;
  rx_mbps: number | null;
  tx_mbps: number | null;
  security: string | null;
  auth: string | null;
  cipher: string | null;
  phy: string | null;
  analysis: { bands?: { band: string; current_channel: number | null; level: string | null; recommended?: { channel: number } | null; evidence?: string[] }[] } | null;
  observed_at: string;
  networks: WifiNetwork[];
}

export interface Fingerprint {
  mac: string;
  prl: string;
  vendor_class: string | null;
  hostname: string | null;
  server_id: string | null;
  os_family: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  seen_at: string;
  device_id: string | null;
  device_name: string | null;
}

export interface Banner {
  device_id: string;
  device_name: string | null;
  port: number;
  ip: string;
  scheme: 'http' | 'https';
  status: number | null;
  title: string | null;
  server: string | null;
  tls_subject: string | null;
  tls_issuer: string | null;
  tls_self_signed: boolean | null;
  probed_at: string;
  device_type: string | null;
  type_source: string | null;
}

export interface Expected {
  id: string;
  kind: ExpectedKind;
  value: string;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

export interface ScheduleEntry {
  enabled: boolean;
  interval_seconds: number;
  automation_key: string;
  listen_seconds?: number;
  ports?: number[];
  due_devices?: number;
}

export interface SecurityOverview {
  site_id: string;
  collectors: { id: string; name: string; os: string | null; online: boolean }[];
  runs: CheckRun[];
  requests: { check_kind: RunnableCheck; requested_at: string }[];
  findings: Finding[];
  dhcp: { servers: DhcpServer[]; probe: { probes: number; last_probe_at: string | null; consecutive_no_offer: number; no_offer_open: boolean } | null };
  upnp: { gateways: UpnpGateway[] };
  wifi: WifiLinkRow[];
  fingerprints: Fingerprint[];
  banners: Banner[];
  expected: Expected[];
  schedule: Record<CheckKind, ScheduleEntry>;
}

/** Findings "this is expected" can approve (routes.ts expectedForFinding). */
export const APPROVABLE_KINDS = ['dhcp_rogue_server', 'wifi_evil_twin', 'upnp_risky_mapping'];
