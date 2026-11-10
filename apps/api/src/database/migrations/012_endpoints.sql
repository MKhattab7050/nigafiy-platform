-- Phase 3 & 4: Endpoint management and remote administration for enrolled machines.
--
-- Each managed computer enrolls with a single-use token and receives its own revocable credential.
-- Remote administration commands are a closed, audited allow-list (refresh_inventory, kill_process,
-- service_action, power_action, notify_user).

CREATE TABLE endpoints (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id               uuid NOT NULL,
  device_id             uuid,
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  connection_state      text NOT NULL DEFAULT 'never' CHECK (connection_state IN ('never', 'online', 'offline')),
  enrollment_token_hash text UNIQUE,
  enrollment_expires_at timestamptz,
  credential_hash       text,
  agent_version         text,
  hostname              text,
  os                    text,
  os_version            text,
  arch                  text,
  cpu_model             text,
  cpu_cores             integer,
  ram_total_mb          integer,
  uptime_seconds        bigint,
  logged_in_users       text[] NOT NULL DEFAULT '{}',
  primary_ip            inet,
  primary_mac           macaddr,
  cpu_pct               double precision,
  ram_used_mb           integer,
  ram_pct               double precision,
  disk_used_pct         double precision,
  disks                 jsonb NOT NULL DEFAULT '[]',
  interfaces            jsonb NOT NULL DEFAULT '[]',
  processes             jsonb NOT NULL DEFAULT '[]',
  services              jsonb NOT NULL DEFAULT '[]',
  software              jsonb NOT NULL DEFAULT '[]',
  connections           jsonb NOT NULL DEFAULT '[]',
  inventory_updated_at  timestamptz,
  last_heartbeat_at     timestamptz,
  created_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX endpoints_site_idx ON endpoints (organization_id, site_id);
CREATE INDEX endpoints_device_idx ON endpoints (device_id) WHERE device_id IS NOT NULL;
CREATE INDEX endpoints_heartbeat_idx ON endpoints (last_heartbeat_at) WHERE status = 'active';

CREATE TABLE endpoint_samples (
  endpoint_id     uuid NOT NULL,
  ts              timestamptz NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  cpu_pct         double precision NOT NULL,
  ram_pct         double precision NOT NULL,
  ram_used_mb     integer NOT NULL,
  disk_used_pct   double precision,
  PRIMARY KEY (endpoint_id, ts),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX endpoint_samples_ts_brin ON endpoint_samples USING brin (ts);

CREATE TABLE endpoint_commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('refresh_inventory', 'kill_process', 'service_action', 'power_action', 'notify_user')),
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'completed', 'failed', 'expired')),
  output          text,
  error           text,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  completed_at    timestamptz,
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX endpoint_commands_endpoint_idx ON endpoint_commands (endpoint_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['endpoints', 'endpoint_samples', 'endpoint_commands'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;

