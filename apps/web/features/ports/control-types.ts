import type { Confidence, PortRole } from '@nigafiy/shared-types';

// Response shapes of the port-control API (apps/api/src/modules/ports/control).

export interface PortRisk {
  code: string;
  source: 'observed' | 'inferred';
  evidence: string;
}

export interface PortValues {
  admin_up?: boolean | null;
  alias?: string | null;
  vlan?: number | null;
}

export interface PortRequest {
  id: string;
  target_id: string;
  switch_name: string;
  if_index: number;
  port_name: string;
  op: 'admin_status' | 'alias' | 'access_vlan';
  params: { admin_up?: boolean; alias?: string; vlan?: number };
  method: string | null;
  before_known: PortValues & { read_at?: string; mode?: string | null };
  risks: PortRisk[];
  override_reason: string | null;
  purpose: 'manual' | 'quarantine' | 'release';
  status: 'pending' | 'verified' | 'failed' | 'expired';
  result: { before: PortValues | null; after: PortValues | null; verified: boolean; rolled_back: boolean; steps: string[]; late?: boolean } | null;
  error: string | null;
  error_kind: string | null;
  created_by_email: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}

export interface Vlan {
  id: number;
  name: string | null;
  source: string;
}

export interface Possible {
  possible: boolean;
  reason?: string;
}

export interface PortControl {
  target_id: string;
  switch_name: string;
  if_index: number;
  port: {
    name: string;
    alias: string | null;
    admin_up: boolean;
    oper_up: boolean;
    role: PortRole;
    read_at: string;
    vlan: { access_vlan: number | null; mode: 'access' | 'trunk' | 'unknown'; source: string | null; read_at: string | null } | null;
  };
  write: { configured: boolean; version: string | null; updated_at: string | null };
  vlan_methods: string[];
  vlans: Vlan[];
  risks: PortRisk[];
  quarantine: { id: string; device_id: string; device_label: string; status: string } | null;
  pending: PortRequest | null;
  blocker: string | null;
  actions: { admin_status: Possible; alias: Possible; access_vlan: Possible };
  ttl_minutes: number;
}

export interface SwitchControl {
  target_id: string;
  site_id: string;
  write: { configured: boolean; version: string | null; updated_at: string | null };
  vlan_methods: string[];
  vlans_read_at: string | null;
  vlans: Vlan[];
  quarantine_vlan: number | null;
  site_quarantine_vlan: number | null;
  effective_quarantine_vlan: number | null;
  pending: PortRequest[];
  quarantines: { id: string; device_id: string; device_label: string; if_index: number; port_name: string; status: string; original_vlan: number; quarantine_vlan: number }[];
  ttl_minutes: number;
}

export interface SitePortControl {
  site_id: string;
  quarantine_vlan: number | null;
  switches: { id: string; name: string; write_configured: boolean; quarantine_vlan: number | null; vlans_read: boolean; quarantine_vlan_present: boolean | null }[];
  vlans: { id: number; name: string | null; switches: number }[];
}

export interface Quarantine {
  id: string;
  device_id: string;
  target_id: string;
  switch_name: string;
  if_index: number;
  port_name: string;
  original_vlan: number;
  quarantine_vlan: number;
  status: 'requested' | 'active' | 'failed' | 'releasing' | 'released';
  reason: string | null;
  location: { kind?: string; confidence?: Confidence; evidence?: string[] };
  last_error: string | null;
  created_by_email: string | null;
  created_at: string;
  activated_at: string | null;
  released_at: string | null;
  released_by_email: string | null;
  /** Optional automatic release, minutes after the verified move; auto_release_at once active. */
  auto_release_minutes: number | null;
  auto_release_at: string | null;
  auto_released: boolean;
}

export interface DeviceQuarantine {
  current: Quarantine | null;
  history: Quarantine[];
  plan: {
    possible: boolean;
    reason?: string;
    message?: string;
    target_id?: string;
    switch_name?: string;
    port_name?: string;
    current_vlan?: number | null;
    quarantine_vlan?: number | null;
    quarantine_vlan_source?: 'switch' | 'site' | null;
    location: { kind: string; confidence: Confidence; evidence: string[] } | null;
  };
  risks: PortRisk[];
  ttl_minutes: number;
}
