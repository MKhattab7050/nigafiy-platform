-- Configuration backup: secret sanitization, sealed raw copies, and admin-confirmed restore.
--
-- Until now config_backup_contents held the normalized configuration *including* its secrets (enable
-- secrets, SNMP communities, pre-shared keys, RADIUS/TACACS+ keys, private keys…), sealed at rest but
-- shown in full to administrators and in diffs. From this migration on:
--
--  * config_backup_contents holds the SANITIZED text: every recognized secret value replaced with
--    "<nigafiy-redacted:hmac=…>", a 48-bit HMAC-SHA-256 fingerprint keyed per target. Hash, diff,
--    view and download all use this text; a changed secret shows as a changed fingerprint.
--  * config_backup_targets.secret_fp_key_enc is that per-target fingerprint key (random 32 bytes,
--    AES-256-GCM sealed, covered by rotate-key; rotation re-seals the same key, so fingerprints stay
--    stable).
--  * config_backup_raw keeps the normalized RAW text of each version, sealed (raw_enc), write-only:
--    no API returns it. It exists only so an administrator-confirmed restore can push the real
--    configuration back to the device.
--
-- Existing rows: SQL cannot decrypt (the application key is not in the database), so every existing
-- content row is marked sanitized = false here. The API re-sanitizes them (modules/configbackup/
-- resanitize.ts): the configuration-backup job converts up to 200 rows every 5 minutes, ingest
-- converts a target's rows before comparing a new backup, and reading a not-yet-converted version
-- sanitizes it in memory before returning it. Conversion keeps the original text as the version's
-- sealed raw copy (so restore works for old versions too) and re-points versions to the sanitized
-- hash.

ALTER TABLE config_backup_targets ADD COLUMN secret_fp_key_enc text;

ALTER TABLE config_backup_contents
  ADD COLUMN sanitized boolean NOT NULL DEFAULT false,
  -- Counts of redacted values per rule id ({"snmp_community": 1, …}); never values.
  ADD COLUMN redactions jsonb;
-- Rows written from now on are sanitized; the default stays false so a forgotten column in an INSERT
-- can never mark unsanitized text as clean.
CREATE INDEX config_backup_contents_unsanitized_idx ON config_backup_contents (target_id) WHERE NOT sanitized;

CREATE TABLE config_backup_raw (
  target_id       uuid NOT NULL,
  -- The sanitized hash of the version this raw text belongs to.
  sha256          text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- AES-256-GCM of the normalized, unsanitized configuration. Never returned by any API.
  raw_enc         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, sha256),
  FOREIGN KEY (organization_id, target_id) REFERENCES config_backup_targets (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (target_id, sha256) REFERENCES config_backup_contents (target_id, sha256) ON DELETE CASCADE
);
ALTER TABLE config_backup_raw ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON config_backup_raw FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON config_backup_raw TO lan_app;

-- Versions are re-pointed to the sanitized hash during conversion.
ALTER TABLE config_backup_versions DROP CONSTRAINT config_backup_versions_target_id_sha256_fkey;
ALTER TABLE config_backup_versions ADD CONSTRAINT config_backup_versions_target_id_sha256_fkey
  FOREIGN KEY (target_id, sha256) REFERENCES config_backup_contents (target_id, sha256) ON UPDATE CASCADE ON DELETE CASCADE;

-- Backups started by a playbook step (`config_backup` action) and the fresh backup taken right before
-- an administrator-confirmed restore are recorded as such.
ALTER TABLE config_backup_runs DROP CONSTRAINT config_backup_runs_trigger_check;
ALTER TABLE config_backup_runs ADD CONSTRAINT config_backup_runs_trigger_check CHECK (trigger IN ('manual', 'scheduled', 'playbook', 'restore'));

-- Switch port control (same release, unrelated to configuration backup): a quarantine can carry an
-- optional automatic release, counted from the verified move to the quarantine VLAN. The
-- quarantine-auto-release job queues the normal verified release when it is due; a failed attempt is
-- retried after 15 minutes (auto_release_attempted_at) and the device stays isolated meanwhile.
ALTER TABLE device_quarantines
  ADD COLUMN auto_release_minutes integer CHECK (auto_release_minutes IS NULL OR auto_release_minutes BETWEEN 5 AND 43200),
  ADD COLUMN auto_release_attempted_at timestamptz;
CREATE INDEX device_quarantines_auto_release_idx ON device_quarantines (activated_at) WHERE status = 'active' AND auto_release_minutes IS NOT NULL;

-- Administrator-confirmed configuration restore (modules/configbackup/restore.ts). One row per
-- request: a fresh backup first (pre_run_id, trigger 'restore'), then the `config_restore` command to
-- the site's collector, which applies the version's sealed raw copy with the vendor's
-- commit-confirmed method and reads the configuration back over a new SSH session (verify_run_id: that
-- read-back is stored as a normal version). Statuses:
--   pre_backup → pending → verified | failed | rolled_back;  pre_backup / pending → expired | failed
-- Never stores configuration text or credentials (those stay in config_backup_raw / the target).
CREATE TABLE config_backup_restores (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id            uuid NOT NULL,
  target_id          uuid NOT NULL,
  version_id         uuid NOT NULL REFERENCES config_backup_versions (id) ON DELETE CASCADE,
  version_number     integer NOT NULL,
  sha256             text NOT NULL,
  method             text NOT NULL,
  status             text NOT NULL CHECK (status IN ('pre_backup', 'pending', 'verified', 'failed', 'rolled_back', 'expired')),
  reason             text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  confirm_minutes    integer NOT NULL CHECK (confirm_minutes BETWEEN 1 AND 10),
  collector_id       uuid,
  pre_run_id         uuid,
  verify_run_id      uuid,
  command_id         uuid,
  after_version_id   uuid,
  committed          boolean,
  confirmed          boolean,
  rolled_back        boolean,
  steps              jsonb NOT NULL DEFAULT '[]',
  error_kind         text,
  error              text,
  requested_by       uuid,
  requested_by_email text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  completed_at       timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, target_id) REFERENCES config_backup_targets (organization_id, id) ON DELETE CASCADE
);
-- At most one restore in progress per device.
CREATE UNIQUE INDEX config_backup_restores_open ON config_backup_restores (target_id) WHERE status IN ('pre_backup', 'pending');
CREATE INDEX config_backup_restores_target ON config_backup_restores (target_id, created_at DESC);
ALTER TABLE config_backup_restores ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON config_backup_restores FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON config_backup_restores TO lan_app;

-- The restore command, added to whatever the allowed list is at this point (see 028).
DO $$
DECLARE
  def   text;
  kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'collector_commands_kind_check' AND conrelid = 'collector_commands'::regclass;
  SELECT coalesce(array_agg(DISTINCT m[1]), '{}') INTO kinds FROM regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'config_restore' = ANY (kinds) THEN
    kinds := kinds || 'config_restore'::text;
  END IF;
  ALTER TABLE collector_commands DROP CONSTRAINT IF EXISTS collector_commands_kind_check;
  EXECUTE format('ALTER TABLE collector_commands ADD CONSTRAINT collector_commands_kind_check CHECK (kind IN (%s))',
                 (SELECT string_agg(quote_literal(k2), ', ' ORDER BY k2) FROM unnest(kinds) AS k2));
END $$;
