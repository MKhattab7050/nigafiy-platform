import type { DeviceTrust } from '@lan-detective/shared-types';
import type { ControlAction } from '@/lib/controls';

// Shapes of the routers API (apps/api/src/modules/routers). Kept here because they are owned by this feature.

export const ROUTER_VENDORS = [
  { value: 'huawei', label: 'Huawei Home / ISP (DG8045 / HG630 / HG633 / HG8145V5 / AX3)', defaultUser: 'admin' },
  { value: 'huawei_lte', label: 'Huawei 4G/5G Home CPE (B315 / B525 / B535 / B818 / H122 / H155)', defaultUser: 'admin' },
  { value: 'zte', label: 'ZTE ZXHN (H168N / H188A / F660 / F670L / F680)', defaultUser: 'admin' },
  { value: 'tplink_archer', label: 'TP-Link Home / Archer (C6 / C80 / AX10 / AX53 / VR400)', defaultUser: 'admin' },
  { value: 'tenda', label: 'Tenda Home (F3 / AC6 / AC10 / AC11 / AC23)', defaultUser: 'admin' },
  { value: 'dlink', label: 'D-Link (DIR-825 / DIR-842 / DIR-878 / EXO / COVR)', defaultUser: 'admin' },
  { value: 'asus', label: 'ASUS (Asuswrt / Merlin)', defaultUser: 'admin' },
  { value: 'zyxel', label: 'Zyxel (VMG3625-T50B / ZCFG)', defaultUser: 'admin' },
  { value: 'mikrotik', label: 'MikroTik (RouterOS v7)', defaultUser: 'admin' },
  { value: 'unifi', label: 'Ubiquiti UniFi Network', defaultUser: 'admin' },
  { value: 'omada', label: 'TP-Link Omada Controller', defaultUser: 'admin' },
  { value: 'openwrt', label: 'OpenWrt (ubus / LuCI)', defaultUser: 'root' },
  { value: 'opnsense', label: 'OPNsense', defaultUser: '' },
  { value: 'pfsense', label: 'Netgate pfSense (REST API v2)', defaultUser: 'api-key' },
  { value: 'fortigate', label: 'Fortinet FortiGate (FortiOS)', defaultUser: 'api' },
  { value: 'cisco_xe', label: 'Cisco IOS XE (RESTCONF)', defaultUser: 'admin' },
] as const;
export type RouterVendor = (typeof ROUTER_VENDORS)[number]['value'];
export const ROUTER_TRANSPORTS = ['https-pinned', 'https', 'http'] as const;
export type RouterTransport = (typeof ROUTER_TRANSPORTS)[number];
export type Delivery = 'active' | 'disabled' | 'out_of_scope' | 'awaiting_certificate' | 'login_paused';
export type RouterHealth = 'never' | 'ok' | 'unreachable' | 'login_failed' | 'locked_out' | 'certificate' | 'not_authorized' | 'error';

export interface Capability {
  capability: string;
  supported: boolean;
  mechanism?: string;
  note?: string;
}

export interface RouterIdentity {
  vendor: string;
  model: string;
  firmware: string;
  extra?: Record<string, string>;
}

export interface SiteRouter {
  id: string;
  site_id: string;
  device_id: string | null;
  name: string;
  vendor: string;
  address: string;
  port: number | null;
  transport: RouterTransport;
  pin_sha256: string | null;
  pinned_at: string | null;
  enabled: boolean;
  refresh_interval_seconds: number;
  status: RouterHealth;
  last_error: string | null;
  last_error_kind: string | null;
  last_checked_at: string | null;
  last_ok_at: string | null;
  login_paused: boolean;
  login_paused_reason: 'bad_credentials' | 'locked_out' | null;
  login_paused_until: string | null;
  identity: RouterIdentity | null;
  capabilities: Capability[] | null;
  clients_refreshed_at: string | null;
  client_count: number;
  credentials: { set: boolean; updated_at: string };
  in_scope: boolean;
  delivery: Delivery;
  created_at: string;
  updated_at: string;
}

export interface FetchedCertificate {
  sha256: string;
  subject: string;
  issuer: string;
  not_before: string;
  not_after: string;
  self_signed: boolean;
  expired: boolean;
  system_trust: boolean;
}

export interface BlockedEntry {
  mac: string;
  name?: string;
  mechanism: string;
  owner: 'lan-detective' | 'administrator' | 'unknown';
  partial?: boolean;
  detail?: string;
  managed: boolean;
}

export interface LedgerEntry {
  id: string;
  mac: string;
  device_id: string | null;
  mechanism: string | null;
  pre_existing: boolean;
  applied_by_email: string | null;
  applied_at: string;
  undo: string | null;
  released_at: string | null;
  released_by_email: string | null;
  released_via: 'product' | 'router' | null;
}

export type RequestAction =
  | 'refresh'
  | 'fetch_certificate'
  | 'block'
  | 'unblock'
  | 'rate_limit'
  | 'clear_rate_limit'
  | 'schedule'
  | 'clear_schedule'
  | 'rename'
  | 'wifi'
  | 'reserve'
  | 'unreserve'
  | 'add_port_forward'
  | 'remove_port_forward'
  | 'reboot';

export interface RouterRequest {
  id: string;
  router_id?: string;
  action: RequestAction;
  mac: string | null;
  device_id: string | null;
  params: Record<string, unknown>;
  status: 'pending' | 'completed' | 'failed' | 'expired';
  result: {
    change?: { action: string; mac: string; mechanism: string; applied: boolean; already_in_effect: boolean; detail: string; undo: string };
    certificate?: FetchedCertificate;
    identity?: RouterIdentity | null;
    clients?: number | null;
    blocked?: number | null;
  } | null;
  error: string | null;
  error_kind: string | null;
  created_by_email: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RouterDetail extends SiteRouter {
  blocked_entries: BlockedEntry[] | null;
  certificate: { pinned: string | null; pinned_at: string | null; fetched: FetchedCertificate | null; fetched_at: string | null };
  blocks: LedgerEntry[];
  recent_requests: RouterRequest[];
}

export interface RouterClient {
  mac: string;
  ip: string | null;
  hostname: string | null;
  connection: string;
  interface: string | null;
  signal_dbm: number | null;
  active: boolean | null;
  lease_source: string | null;
  lease_remaining_seconds: number | null;
  blocked: boolean | null;
  raw: Record<string, string> | null;
  first_seen_at: string;
  last_seen_at: string;
  device_id: string | null;
  device_label: string | null;
  device_trust: DeviceTrust | null;
  ledger: { id: string; pre_existing: boolean; applied_by_email: string | null; applied_at: string } | null;
  device_link: 'inferred_by_mac' | null;
}

export interface QueuedRequest {
  request_id: string;
  collector?: string;
  already_pending?: boolean;
}

export interface DeviceResult {
  device_id: string;
  status: 'queued' | 'refused';
  code?: string;
  message?: string;
  request_id?: string;
}

export interface BlockResponse {
  router_id: string;
  action: 'block' | 'unblock';
  queued: number;
  results: DeviceResult[];
}

/** A device as the block dialog names it. */
export interface DeviceRef {
  id: string;
  label: string;
  ip?: string | null;
  mac?: string | null;
}

/** The `router` section of GET /devices/:id/controls. */
export interface ProductSchedule {
  mode: 'product';
  windows: { days: number[]; start: string; end: string }[];
  timezone: string;
  created_by_email: string | null;
  updated_at: string;
  removing: boolean;
  in_window: boolean;
  paused_until: string | null;
  /** The schedule's own block is in effect (or on its way). */
  blocking: boolean;
  last_error: string | null;
}

/** POST /routers/:id/schedule: queued on the router, or stored and enforced by LAN Detective. */
export type ScheduleResponse = (QueuedRequest & { mode?: 'router' }) | { mode: 'product'; outcome: string; schedule: ProductSchedule | null };

export interface DeviceRouterControls {
  routers: {
    router_id: string;
    name: string;
    address: string;
    status: RouterHealth;
    delivery: Delivery;
    login_paused: boolean;
    login_paused_reason: string | null;
    sees_device:
      | {
          ip: string | null;
          hostname: string | null;
          connection: string;
          interface: string | null;
          signal_dbm: number | null;
          active: boolean | null;
          blocked: boolean | null;
          lease_source: string | null;
          lease_remaining_seconds: number | null;
          last_seen_at: string;
          link: 'inferred_by_mac';
        }
      | null;
    block_state: {
      state: 'blocked' | 'not_blocked' | 'unknown';
      by: string | null;
      applied_by_email: string | null;
      applied_at: string | null;
      mechanism: string | null;
      undo: string | null;
      router_entries: { mac: string; owner: string; mechanism: string; partial?: boolean; detail?: string }[];
    };
    capabilities: Capability[] | null;
    /** As the router last reported them; null when not read yet or not offered. */
    reservation?: RouterReservation | null;
    port_forwards?: (PortForwardRule & { actions: { remove: ControlAction } })[] | null;
    lan?: { cidr: string; source: 'collector_interface' | 'assumed_24' };
    /** A schedule LAN Detective enforces itself with the router's block (null: none). */
    schedule?: ProductSchedule | null;
    actions: {
      block: ControlAction;
      unblock: ControlAction;
      rate_limit: ControlAction;
      schedule: ControlAction;
      rename?: ControlAction;
      reserve?: ControlAction;
      unreserve?: ControlAction;
      port_forward?: ControlAction;
    };
  }[];
  protected: { code: string; message: string } | null;
  setup: { reason: string; href: string; note: string } | null;
}

// Router settings (docs/features/router-controls.md): GET /routers/:id/settings.
export interface WanLink {
  name: string;
  status: 'up' | 'down' | 'connecting' | 'unknown';
  type?: string;
  ipv4?: string;
  dns?: string[];
  uptime_seconds?: number;
}

export interface WifiNetwork {
  id: string;
  band?: string;
  ssid: string;
  enabled: boolean;
  main: boolean;
  guest: boolean;
  hidden?: boolean;
  security?: string;
  client_macs?: string[];
  client_count: number | null;
}

export interface RouterReservation {
  id: string;
  mac: string;
  ip: string;
  enabled?: boolean;
  device_id?: string | null;
  device_label?: string | null;
}

export type PortProtocol = 'tcp' | 'udp' | 'both';

export interface PortForwardRule {
  id: string;
  enabled: boolean;
  description: string;
  protocol: PortProtocol;
  external_start: number;
  external_end: number;
  internal_start: number;
  internal_end: number;
  internal_ip: string;
  owner: 'lan-detective' | 'administrator';
  device_id?: string | null;
  device_label?: string | null;
}

export interface RouterSettingsView {
  router_id: string;
  settings_at: string | null;
  lan: { cidr: string; source: 'collector_interface' | 'assumed_24'; router_ips: string[] };
  overview: { uptime_seconds?: number; lan_ip?: string; wan?: WanLink[] } | null;
  wifi: WifiNetwork[] | null;
  reservations: RouterReservation[] | null;
  port_forwards: PortForwardRule[] | null;
  pending: { id: string; action: RequestAction; mac: string | null; device_id: string | null; params: Record<string, unknown>; created_by_email: string | null; created_at: string }[];
}
