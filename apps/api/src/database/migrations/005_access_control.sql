-- Network access control that works with any router.
--
-- The site's collector can answer DNS for the local network (the owner points the router's DHCP
-- "DNS server" at it). Rules decide per device which names get an empty answer: blocked
-- categories and domains, an internet pause, and bedtime schedules. Rules are layered:
--   site defaults  →  the device's profile (e.g. "Kids", "Guests")  →  the device's own settings.

CREATE TABLE site_access (
  site_id            uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT false,
  blocked_categories text[] NOT NULL DEFAULT '{}',
  blocked_domains    text[] NOT NULL DEFAULT '{}',
  allowed_domains    text[] NOT NULL DEFAULT '{}',
  upstreams          text[] NOT NULL DEFAULT '{}',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE access_profiles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id            uuid NOT NULL,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  blocked_categories text[] NOT NULL DEFAULT '{}',
  blocked_domains    text[] NOT NULL DEFAULT '{}',
  allowed_domains    text[] NOT NULL DEFAULT '{}',
  -- [{ "days": [0..6], "from": "22:00", "to": "07:00" }] — internet off during these windows.
  schedule           jsonb NOT NULL DEFAULT '[]',
  paused_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (site_id, name),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

ALTER TABLE devices
  ADD COLUMN access_profile_id uuid,
  ADD COLUMN internet_paused_until timestamptz,
  ADD COLUMN access_blocked_domains text[] NOT NULL DEFAULT '{}',
  ADD COLUMN access_allowed_domains text[] NOT NULL DEFAULT '{}',
  ADD COLUMN access_schedule jsonb NOT NULL DEFAULT '[]';
ALTER TABLE devices
  ADD CONSTRAINT devices_access_profile_fk FOREIGN KEY (organization_id, access_profile_id)
  REFERENCES access_profiles (organization_id, id) ON DELETE SET NULL (access_profile_id);

-- What the collector reports about the filter (listening, errors, list sizes).
ALTER TABLE collectors ADD COLUMN access_status jsonb;

-- DNS activity per device in collector windows (about 5 minutes): totals plus the top names.
CREATE TABLE dns_stats (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  collector_id    uuid NOT NULL,
  device_id       uuid,
  client_ip       inet NOT NULL,
  mac             macaddr,
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  queries         integer NOT NULL CHECK (queries >= 0),
  blocked         integer NOT NULL CHECK (blocked >= 0),
  top_domains     jsonb NOT NULL DEFAULT '[]',
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX dns_stats_site_time_idx ON dns_stats (organization_id, site_id, window_end DESC);
CREATE INDEX dns_stats_device_time_idx ON dns_stats (device_id, window_end DESC) WHERE device_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_access', 'access_profiles', 'dns_stats'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;
GRANT USAGE ON SEQUENCE dns_stats_id_seq TO lan_app;
