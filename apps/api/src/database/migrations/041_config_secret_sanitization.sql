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
