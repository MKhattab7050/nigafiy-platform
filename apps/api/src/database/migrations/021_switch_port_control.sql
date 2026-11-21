-- Port Detective port control (Phase 5): switch port write actions over SNMP SET, access VLAN
-- assignment, and device quarantine.
--
--  * snmp_targets gains separate WRITE credentials (AES-256-GCM, write-only, delivered to the site's
--    collector only while a change for that switch is pending), the detected vendor, and an optional
--    per-switch quarantine VLAN.
--  * switch_vlans / switch_port_vlans: the VLANs a switch defines and each port's VLAN membership,
--    as read by the collector (Q-BRIDGE-MIB or Cisco VTP / VLAN-membership MIB).
--  * switch_port_settings: per-site port-control settings (the quarantine VLAN).
--  * switch_port_requests: every requested port change, with the values before (as last read and as
--    the collector read them right before writing) and after (read back), and its outcome.
--  * device_quarantines: a device moved to the quarantine VLAN, with the original VLAN so "Release"
--    restores it.

ALTER TABLE snmp_targets
  ADD COLUMN write_version     text CHECK (write_version IS NULL OR write_version IN ('2c', '3')),
  -- AES-256-GCM JSON: { community } or { username, auth_protocol, auth_password, priv_protocol, priv_password }
  ADD COLUMN write_secret_enc  text,
  ADD COLUMN write_updated_at  timestamptz,
  ADD COLUMN write_updated_by  uuid,
  ADD COLUMN sys_object_id     text,
  -- Write methods the switch's tables support, as last read: {qbridge, cisco}.
  ADD COLUMN vlan_methods      text[] NOT NULL DEFAULT '{}',
  ADD COLUMN vlans_read_at     timestamptz,
  ADD COLUMN quarantine_vlan   integer CHECK (quarantine_vlan IS NULL OR quarantine_vlan BETWEEN 1 AND 4094),
  ADD CONSTRAINT snmp_targets_write_pair CHECK ((write_version IS NULL) = (write_secret_enc IS NULL));

CREATE TABLE switch_vlans (
  target_id       uuid NOT NULL,
  vlan_id         integer NOT NULL CHECK (vlan_id BETWEEN 1 AND 4094),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name            text,
  source          text NOT NULL CHECK (source IN ('qbridge', 'cisco')),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, vlan_id),
  FOREIGN KEY (organization_id, target_id) REFERENCES snmp_targets (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE switch_port_vlans (
  target_id       uuid NOT NULL,
  if_index        integer NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  access_vlan     integer CHECK (access_vlan IS NULL OR access_vlan BETWEEN 1 AND 4094),
  mode            text NOT NULL CHECK (mode IN ('access', 'trunk', 'unknown')),
  source          text NOT NULL CHECK (source IN ('qbridge', 'cisco')),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, if_index),
  FOREIGN KEY (organization_id, target_id) REFERENCES snmp_targets (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE switch_port_settings (
  site_id         uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  quarantine_vlan integer CHECK (quarantine_vlan IS NULL OR quarantine_vlan BETWEEN 1 AND 4094),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE switch_port_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id          uuid NOT NULL,
  target_id        uuid NOT NULL,
  collector_id     uuid,
  if_index         integer NOT NULL,
  port_name        text NOT NULL,
  op               text NOT NULL CHECK (op IN ('admin_status', 'alias', 'access_vlan')),
  -- The requested value: { admin_up } | { alias } | { vlan }.
  params           jsonb NOT NULL,
  method           text CHECK (method IS NULL OR method IN ('ifmib', 'qbridge', 'cisco')),
  -- Values as LAN Detective last read them when the request was made (inferred "before").
  before_known     jsonb NOT NULL DEFAULT '{}',
  -- What made the port look risky (uplink, trunk, collector/gateway behind it…) and the override.
  risks            jsonb NOT NULL DEFAULT '[]',
  override_reason  text CHECK (override_reason IS NULL OR length(override_reason) BETWEEN 1 AND 500),
  purpose          text NOT NULL DEFAULT 'manual' CHECK (purpose IN ('manual', 'quarantine', 'release')),
  quarantine_id    uuid,
  -- Who asked: a person (user) or an automation (automation key in requested_via).
  requested_via    text NOT NULL DEFAULT 'user',
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
  -- Collector report: { before, after, verified, rolled_back, steps, duration_ms } (observed values).
  result           jsonb,
  error            text,
  error_kind       text,
  created_by       uuid,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, target_id) REFERENCES snmp_targets (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX switch_port_requests_target_idx ON switch_port_requests (target_id, created_at DESC);
-- One change at a time per port.
CREATE UNIQUE INDEX switch_port_requests_one_pending ON switch_port_requests (target_id, if_index) WHERE status = 'pending';

CREATE TABLE device_quarantines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id            uuid NOT NULL,
  device_id          uuid NOT NULL,
  target_id          uuid NOT NULL,
  if_index           integer NOT NULL,
  port_name          text NOT NULL,
  original_vlan      integer NOT NULL CHECK (original_vlan BETWEEN 1 AND 4094),
  quarantine_vlan    integer NOT NULL CHECK (quarantine_vlan BETWEEN 1 AND 4094),
  -- requested → active (verified) | failed;  active → releasing → released | active (release failed).
  status             text NOT NULL CHECK (status IN ('requested', 'active', 'failed', 'releasing', 'released')),
  reason             text CHECK (reason IS NULL OR length(reason) <= 500),
  -- How the port was found: the location evidence at the time (kind, confidence, evidence lines).
  location           jsonb NOT NULL DEFAULT '{}',
  request_id         uuid,
  release_request_id uuid,
  last_error         text,
  requested_via      text NOT NULL DEFAULT 'user',
  created_by         uuid,
  created_by_email   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  activated_at       timestamptz,
  released_at        timestamptz,
  released_by_email  text,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, target_id) REFERENCES snmp_targets (organization_id, id) ON DELETE CASCADE
);
-- At most one open quarantine per device and per port.
CREATE UNIQUE INDEX device_quarantines_open_device ON device_quarantines (device_id) WHERE status IN ('requested', 'active', 'releasing');
CREATE UNIQUE INDEX device_quarantines_open_port ON device_quarantines (target_id, if_index) WHERE status IN ('requested', 'active', 'releasing');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['switch_vlans', 'switch_port_vlans', 'switch_port_settings', 'switch_port_requests', 'device_quarantines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;

-- Collector command `set_switch_port`. Added to whatever the allowed list is at this point (other
-- migrations extend the same list), so no earlier command kind is lost.
DO $$
DECLARE
  def   text;
  kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'collector_commands_kind_check' AND conrelid = 'collector_commands'::regclass;
  SELECT coalesce(array_agg(DISTINCT m[1]), '{}') INTO kinds FROM regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'set_switch_port' = ANY (kinds) THEN
    kinds := array_append(kinds, 'set_switch_port'::text);
  END IF;
  ALTER TABLE collector_commands DROP CONSTRAINT IF EXISTS collector_commands_kind_check;
  EXECUTE format('ALTER TABLE collector_commands ADD CONSTRAINT collector_commands_kind_check CHECK (kind IN (%s))',
                 (SELECT string_agg(quote_literal(k), ', ' ORDER BY k) FROM unnest(kinds) AS k));
END $$;
