-- Phase 5 — network device configuration backup & version diffing (modules/configbackup).
--
-- The site's collector logs in to routers, switches and firewalls over SSH (read-only: a closed list
-- of "show / display / export" commands per vendor) and reports the running configuration.
--
--  * config_backup_targets   one device to back up. SSH credentials are sealed with the application
--                            key (AES-256-GCM, like router and SNMP credentials), write-only, and
--                            delivered to the site's own collector only inside a pending backup
--                            command. The SSH host key is pinned on first use; a different key stops
--                            every backup of the device until an administrator accepts the new key.
--  * config_backup_contents  configuration texts, stored once per target and SHA-256 of the
--                            normalized text (volatile lines such as "Last configuration change at"
--                            removed), sealed at rest: a configuration carries password hashes and
--                            SNMP communities.
--  * config_backup_versions  the timeline: a new version only when the configuration changed; an
--                            unchanged backup only confirms the latest version (last_seen_at).
--  * config_backup_runs      every backup attempt (manual or scheduled) and its outcome.
--  * config_backup_probe_runs / config_backup_probes
--                            read-only SSH reachability checks (TCP connect + the SSH identification
--                            line, no login) used to suggest devices to back up and their vendor.
-- Every table carries organization_id and is isolated by Row Level Security.

CREATE TABLE config_backup_targets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id                uuid NOT NULL,
  -- Device of the same site with this address when the target was added (an inferred link).
  device_id              uuid,
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  address                inet NOT NULL,
  port                   integer NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  -- The administrator's explicit vendor choice; NULL = auto-detect on every backup.
  driver                 text CHECK (driver IS NULL OR driver ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- What the collector detected on the last backup that got that far: driver, confidence, evidence.
  detected_driver        text,
  detection              jsonb,
  server_version         text,
  -- AES-256-GCM JSON { username, password?, private_key?, passphrase?, enable_secret? }. Write-only.
  secret_enc             text,
  credentials_updated_at timestamptz,
  credentials_updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- The device rejected the credentials: scheduled backups stop (no lock-out) until they are replaced.
  credentials_rejected   boolean NOT NULL DEFAULT false,
  -- SSH host key pin ("SHA256:<base64>" as OpenSSH prints it) and how it was pinned.
  host_key_sha256        text CHECK (host_key_sha256 IS NULL OR host_key_sha256 ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
  host_key_type          text CHECK (host_key_type IS NULL OR length(host_key_type) <= 60),
  host_key_pinned_at     timestamptz,
  host_key_pinned_via    text CHECK (host_key_pinned_via IS NULL OR host_key_pinned_via IN ('first_use', 'admin')),
  host_key_status        text NOT NULL DEFAULT 'none' CHECK (host_key_status IN ('none', 'pinned', 'changed')),
  -- The different key the device presented ({ sha256, type, seen_at }) while host_key_status = 'changed'.
  presented_host_key     jsonb,
  enabled                boolean NOT NULL DEFAULT true,
  schedule               text NOT NULL DEFAULT 'daily' CHECK (schedule IN ('daily', 'off')),
  -- Local hour (site time zone) of the daily backup.
  schedule_hour          integer NOT NULL DEFAULT 2 CHECK (schedule_hour BETWEEN 0 AND 23),
  next_run_at            timestamptz,
  last_run_at            timestamptz,
  last_success_at        timestamptz,
  last_changed_at        timestamptz,
  last_status            text NOT NULL DEFAULT 'never' CHECK (last_status IN ('never', 'ok', 'failed')),
  last_error             text,
  last_error_kind        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (site_id, address, port),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX config_backup_targets_site_idx ON config_backup_targets (organization_id, site_id);
CREATE INDEX config_backup_targets_due_idx ON config_backup_targets (next_run_at) WHERE enabled AND schedule <> 'off';

CREATE TABLE config_backup_contents (
  target_id       uuid NOT NULL,
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- AES-256-GCM of the normalized configuration text.
  content_enc     text NOT NULL,
  size_bytes      integer NOT NULL CHECK (size_bytes >= 0),
  line_count      integer NOT NULL CHECK (line_count >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, sha256),
  FOREIGN KEY (organization_id, target_id) REFERENCES config_backup_targets (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE config_backup_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id          uuid NOT NULL,
  target_id        uuid NOT NULL,
  collector_id     uuid,
  command_id       uuid,
  trigger          text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed', 'expired')),
  outcome          text CHECK (outcome IS NULL OR outcome IN ('first', 'changed', 'unchanged')),
  version_id       uuid,
  host_key_status  text CHECK (host_key_status IS NULL OR host_key_status IN ('first_use', 'matched', 'changed')),
  error_kind       text,
  error            text,
  duration_ms      integer,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, target_id) REFERENCES config_backup_targets (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX config_backup_runs_target_idx ON config_backup_runs (target_id, created_at DESC);
-- One backup at a time per device.
CREATE UNIQUE INDEX config_backup_runs_one_pending ON config_backup_runs (target_id) WHERE status = 'pending';

CREATE TABLE config_backup_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  target_id       uuid NOT NULL,
  number          integer NOT NULL CHECK (number >= 1),
  sha256          text NOT NULL,
  captured_at     timestamptz NOT NULL,
  -- Last backup that found exactly this configuration (unchanged backups only move this forward).
  last_seen_at    timestamptz NOT NULL,
  confirmations   integer NOT NULL DEFAULT 1,
  run_id          uuid,
  collector_id    uuid,
  driver          text,
  -- Line changes against the previous version (0/0 for the first version).
  added_lines     integer NOT NULL DEFAULT 0,
  removed_lines   integer NOT NULL DEFAULT 0,
  UNIQUE (organization_id, id),
  UNIQUE (target_id, number),
  FOREIGN KEY (organization_id, target_id) REFERENCES config_backup_targets (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (target_id, sha256) REFERENCES config_backup_contents (target_id, sha256) ON DELETE CASCADE
);
CREATE INDEX config_backup_versions_target_idx ON config_backup_versions (target_id, number DESC);

CREATE TABLE config_backup_probe_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  collector_id    uuid,
  trigger         text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'expired')),
  address_count   integer NOT NULL DEFAULT 0,
  open_count      integer,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  completed_at    timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX config_backup_probe_runs_site_idx ON config_backup_probe_runs (site_id, created_at DESC);
CREATE UNIQUE INDEX config_backup_probe_runs_one_pending ON config_backup_probe_runs (site_id) WHERE status = 'pending';

CREATE TABLE config_backup_probes (
  site_id         uuid NOT NULL,
  address         inet NOT NULL,
  port            integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  open            boolean NOT NULL,
  -- The SSH identification line the device sent ("SSH-2.0-Cisco-1.25"): device-supplied text.
  server_version  text,
  error           text,
  checked_at      timestamptz NOT NULL,
  PRIMARY KEY (site_id, address, port),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['config_backup_targets', 'config_backup_contents', 'config_backup_runs', 'config_backup_versions',
                           'config_backup_probe_runs', 'config_backup_probes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;

-- Collector commands `config_backup` and `config_backup_probe`. Added to whatever the allowed list is
-- at this point (other migrations extend the same list), so no earlier command kind is lost.
DO $$
DECLARE
  def   text;
  kinds text[];
  k     text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'collector_commands_kind_check' AND conrelid = 'collector_commands'::regclass;
  SELECT coalesce(array_agg(DISTINCT m[1]), '{}') INTO kinds FROM regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g') AS m;
  FOREACH k IN ARRAY ARRAY['config_backup', 'config_backup_probe'] LOOP
    IF NOT k = ANY (kinds) THEN
      kinds := kinds || k;
    END IF;
  END LOOP;
  ALTER TABLE collector_commands DROP CONSTRAINT IF EXISTS collector_commands_kind_check;
  EXECUTE format('ALTER TABLE collector_commands ADD CONSTRAINT collector_commands_kind_check CHECK (kind IN (%s))',
                 (SELECT string_agg(quote_literal(k2), ', ' ORDER BY k2) FROM unnest(kinds) AS k2));
END $$;
