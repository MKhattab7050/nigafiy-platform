-- 048: APK files out of the database (docs/features/android.md "Where APK files live").
--
-- fleet_android_apks kept each APK's bytes in `content` (bytea, migration 045). The bytes now live in
-- the API's file store (apps/api/src/infrastructure/file-store.ts), by default
--   <NIGAFIY_DATA_DIR>/files/apks/<organization id>/<sha256>
-- and the row keeps a reference: storage_key ("apks/<organization id>/<sha256>"), with the existing
-- size_bytes and sha256 columns to check the file on every read.
--
-- Moving existing rows: database/migrate.ts runs apk-file-mover.ts in this migration's transaction
-- just before this SQL. It writes each row's bytes to the store (content-addressed, atomic, checked)
-- and lists the moved ids in the temporary table _apk_files_moved. This SQL refuses to go on unless
-- every row was moved; a failure rolls everything back and the move runs again on the next start.
-- Row Level Security and grants are unchanged (SELECT, INSERT, DELETE for lan_app).

ALTER TABLE fleet_android_apks ADD COLUMN storage_key text;

DO $$
DECLARE
  missing bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_android_apks) THEN
    IF to_regclass('pg_temp._apk_files_moved') IS NULL THEN
      RAISE EXCEPTION 'fleet_android_apks has APKs but they were not moved to the file store: apply migrations with the Nigafiy migrator (pnpm --filter ./apps/api migrate, or an API start), not with psql';
    END IF;
    EXECUTE 'SELECT count(*) FROM fleet_android_apks a WHERE NOT EXISTS (SELECT 1 FROM pg_temp._apk_files_moved m WHERE m.id = a.id)' INTO missing;
    IF missing > 0 THEN
      RAISE EXCEPTION '% APK(s) were not moved to the file store; nothing was changed', missing;
    END IF;
  END IF;
END $$;

UPDATE fleet_android_apks SET storage_key = 'apks/' || organization_id::text || '/' || sha256;

ALTER TABLE fleet_android_apks
  ALTER COLUMN storage_key SET NOT NULL,
  ADD CONSTRAINT fleet_android_apks_storage_key_check CHECK (storage_key = 'apks/' || organization_id::text || '/' || sha256);

CREATE INDEX fleet_android_apks_storage_key_idx ON fleet_android_apks (storage_key);

ALTER TABLE fleet_android_apks DROP COLUMN content;
