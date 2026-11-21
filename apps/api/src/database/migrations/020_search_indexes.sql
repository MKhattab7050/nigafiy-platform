-- Global search: trigram indexes for the substring (ILIKE '%…%') matches of GET /api/v1/search.
--
-- pg_trgm ships with PostgreSQL's contrib package (present in the embedded server used for
-- development and tests) and is a trusted extension, so a database owner may install it. Where it is
-- not available the migration still succeeds: search then falls back to sequential scans, which stay
-- fast for a few thousand rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'pg_trgm not installed (insufficient privilege); search uses sequential scans';
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS devices_search_trgm ON devices
      USING gin ((coalesce(display_name, '') || ' ' || coalesce(hostname, '') || ' ' || coalesce(vendor, '') || ' ' || coalesce(owner, '')) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS endpoints_search_trgm ON endpoints
      USING gin ((coalesce(name, '') || ' ' || coalesce(hostname, '') || ' ' || coalesce(serial_number, '')) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS incidents_title_trgm ON incidents USING gin (title gin_trgm_ops);
  END IF;
END $$;

-- Plain indexes used by exact / prefix matches whatever the extension.
CREATE INDEX IF NOT EXISTS device_tags_tag_idx ON device_tags (organization_id, lower(tag));
CREATE INDEX IF NOT EXISTS devices_mac_text_idx ON devices (organization_id, (replace(primary_mac::text, ':', '')) text_pattern_ops);
CREATE INDEX IF NOT EXISTS incidents_number_idx ON incidents (organization_id, number);
