-- Maintenance windows: planned work during which matching events are still recorded (marked
-- in_maintenance) but open no incident and send no notification.
--
--  * maintenance_windows  a window for one site (or the whole organization when site_id is NULL),
--                         on wall-clock times of `timezone` (the site's zone when created), optionally
--                         repeating weekly on the given weekdays (0 = Sunday … 6 = Saturday) until
--                         `recur_until`. Targets: everything in scope (target_all) or listed devices,
--                         checks and collectors.
--  * maintenance_runs     one row per occurrence that actually started: drives the once-only
--                         maintenance_started / maintenance_ended events and the re-evaluation at the
--                         end. It keeps a snapshot of the scope so a window deleted or edited while
--                         active still ends cleanly.

CREATE TABLE maintenance_windows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  timezone        text NOT NULL,
  starts_local    timestamp NOT NULL,
  ends_local      timestamp NOT NULL,
  weekdays        smallint[] CHECK (weekdays IS NULL OR (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[])),
  recur_until     date,
  target_all      boolean NOT NULL DEFAULT true,
  device_ids      uuid[] NOT NULL DEFAULT '{}',
  check_ids       uuid[] NOT NULL DEFAULT '{}',
  collector_ids   uuid[] NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  CHECK (ends_local > starts_local),
  -- A weekly occurrence is at most a week long; a one-off window at most 90 days.
  CHECK (CASE WHEN weekdays IS NULL THEN ends_local - starts_local <= interval '90 days' ELSE ends_local - starts_local <= interval '7 days' END),
  CHECK (recur_until IS NULL OR weekdays IS NOT NULL),
  CHECK (target_all OR cardinality(device_ids) + cardinality(check_ids) + cardinality(collector_ids) > 0)
);
CREATE INDEX maintenance_windows_org_idx ON maintenance_windows (organization_id, site_id);

CREATE TABLE maintenance_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  window_id        uuid REFERENCES maintenance_windows (id) ON DELETE SET NULL,
  site_id          uuid,
  reason           text NOT NULL,
  occurrence_start timestamptz NOT NULL,
  occurrence_end   timestamptz NOT NULL,
  -- { target_all, device_ids, check_ids, collector_ids } at the time the occurrence started.
  scope            jsonb NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  UNIQUE (window_id, occurrence_start),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX maintenance_runs_open_idx ON maintenance_runs (organization_id) WHERE ended_at IS NULL;

-- Events recorded while a matching window was active.
ALTER TABLE network_events
  ADD COLUMN in_maintenance        boolean NOT NULL DEFAULT false,
  ADD COLUMN maintenance_window_id uuid;

/**
 * The occurrence of a window that contains `p_at`, or NULL. Wall-clock times are converted with the
 * window's zone, so an occurrence keeps its local time across daylight-saving changes.
 */
CREATE FUNCTION maintenance_occurrence(p_start timestamp, p_end timestamp, p_tz text, p_weekdays smallint[], p_until date, p_at timestamptz)
RETURNS tstzrange LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_weekdays IS NULL THEN
      CASE WHEN p_at >= (p_start AT TIME ZONE p_tz) AND p_at < (p_end AT TIME ZONE p_tz)
           THEN tstzrange(p_start AT TIME ZONE p_tz, p_end AT TIME ZONE p_tz) END
    ELSE (
      SELECT tstzrange(o.s, o.e)
        FROM (SELECT (g.d + p_start::time) AT TIME ZONE p_tz AS s,
                     (g.d + p_start::time + (p_end - p_start)) AT TIME ZONE p_tz AS e
                FROM generate_series(((p_at AT TIME ZONE p_tz)::date - 8)::timestamp, ((p_at AT TIME ZONE p_tz)::date)::timestamp, interval '1 day') AS g(d)
               WHERE extract(dow FROM g.d)::smallint = ANY (p_weekdays)
                 AND g.d::date >= p_start::date
                 AND (p_until IS NULL OR g.d::date <= p_until)) o
       WHERE p_at >= o.s AND p_at < o.e
       ORDER BY o.s DESC LIMIT 1)
  END
$$;

/** The next occurrence that starts after `p_at`, or NULL (one-off already started, or recurrence over). */
CREATE FUNCTION maintenance_next_occurrence(p_start timestamp, p_end timestamp, p_tz text, p_weekdays smallint[], p_until date, p_at timestamptz)
RETURNS tstzrange LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_weekdays IS NULL THEN
      CASE WHEN (p_start AT TIME ZONE p_tz) > p_at THEN tstzrange(p_start AT TIME ZONE p_tz, p_end AT TIME ZONE p_tz) END
    ELSE (
      SELECT tstzrange(o.s, o.e)
        FROM (SELECT (g.d + p_start::time) AT TIME ZONE p_tz AS s,
                     (g.d + p_start::time + (p_end - p_start)) AT TIME ZONE p_tz AS e
                FROM generate_series(greatest((p_at AT TIME ZONE p_tz)::date, p_start::date)::timestamp,
                                     (greatest((p_at AT TIME ZONE p_tz)::date, p_start::date) + 8)::timestamp, interval '1 day') AS g(d)
               WHERE extract(dow FROM g.d)::smallint = ANY (p_weekdays)
                 AND (p_until IS NULL OR g.d::date <= p_until)) o
       WHERE o.s > p_at
       ORDER BY o.s LIMIT 1)
  END
$$;
GRANT EXECUTE ON FUNCTION maintenance_occurrence(timestamp, timestamp, text, smallint[], date, timestamptz) TO lan_app;
GRANT EXECUTE ON FUNCTION maintenance_next_occurrence(timestamp, timestamp, text, smallint[], date, timestamptz) TO lan_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['maintenance_windows', 'maintenance_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;
