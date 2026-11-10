-- Port Detective: which switch port is a device plugged into?
--
-- The site's collector reads managed switches over SNMP (read-only): interfaces, the forwarding
-- table (MAC address → port) and LLDP neighbours. Credentials are stored encrypted with the
-- application key and are never returned by the API.

CREATE TABLE snmp_targets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id               uuid NOT NULL,
  device_id             uuid,
  name                  text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 80),
  host                  inet NOT NULL,
  port                  integer NOT NULL DEFAULT 161 CHECK (port BETWEEN 1 AND 65535),
  version               text NOT NULL CHECK (version IN ('2c', '3')),
  -- AES-256-GCM JSON: { community } or { username, auth_protocol, auth_password, priv_protocol, priv_password }
  secret_enc            text NOT NULL,
  enabled               boolean NOT NULL DEFAULT true,
  poll_interval_seconds integer NOT NULL DEFAULT 300 CHECK (poll_interval_seconds BETWEEN 60 AND 86400),
  last_polled_at        timestamptz,
  last_ok_at            timestamptz,
  last_status           text NOT NULL DEFAULT 'never' CHECK (last_status IN ('never', 'ok', 'error')),
  last_error            text,
  sys_name              text,
  sys_descr             text,
  truncated             text[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  UNIQUE (organization_id, id),
  UNIQUE (site_id, host, port),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);

CREATE TABLE switch_ports (
  target_id        uuid NOT NULL,
  if_index         integer NOT NULL,
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name             text NOT NULL,
  descr            text,
  alias            text,
  admin_up         boolean NOT NULL,
  oper_up          boolean NOT NULL,
  speed_mbps       bigint NOT NULL DEFAULT 0,
  in_errors        numeric(20, 0) NOT NULL DEFAULT 0,
  out_errors       numeric(20, 0) NOT NULL DEFAULT 0,
  in_discards      numeric(20, 0) NOT NULL DEFAULT 0,
  out_discards     numeric(20, 0) NOT NULL DEFAULT 0,
  in_octets        numeric(20, 0) NOT NULL DEFAULT 0,
  out_octets       numeric(20, 0) NOT NULL DEFAULT 0,
  -- Change since the previous read (NULL on the first read or after a counter reset).
  errors_delta     bigint,
  discards_delta   bigint,
  delta_seconds    integer,
  mac_count        integer NOT NULL DEFAULT 0,
  -- LLDP neighbours heard on this port: [{ sys_name, port_id, port_descr, chassis_id }]
  neighbors        jsonb NOT NULL DEFAULT '[]',
  oper_changed_at  timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, if_index),
  FOREIGN KEY (organization_id, target_id) REFERENCES snmp_targets (organization_id, id) ON DELETE CASCADE
);

-- The forwarding table as of the last successful read.
CREATE TABLE switch_fdb (
  target_id       uuid NOT NULL,
  mac             macaddr NOT NULL,
  vlan            integer NOT NULL DEFAULT 0,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  if_index        integer NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, mac, vlan),
  FOREIGN KEY (organization_id, target_id) REFERENCES snmp_targets (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX switch_fdb_mac_idx ON switch_fdb (organization_id, mac);
CREATE INDEX switch_fdb_port_idx ON switch_fdb (target_id, if_index);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['snmp_targets', 'switch_ports', 'switch_fdb'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;

ALTER TABLE collector_commands DROP CONSTRAINT collector_commands_kind_check;
ALTER TABLE collector_commands ADD CONSTRAINT collector_commands_kind_check CHECK (kind IN ('run_discovery', 'run_checks', 'wake_device', 'poll_snmp'));
