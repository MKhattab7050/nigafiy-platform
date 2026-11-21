-- Phase 5 — zero-configuration smart network checks run by the collector (modules/security).
--
--  * smart_check_runs      last run of each check per collector (status, error such as "could not listen")
--  * smart_check_requests  "run now" requests, delivered to the site's collectors in the heartbeat
--  * dhcp_servers          DHCP servers that answered the collector's DHCPDISCOVER probe (never a REQUEST)
--                          or that clients were overheard choosing (option 54 in their DHCPREQUEST)
--  * dhcp_probe_state      per-site counters for "no DHCP offer"
--  * upnp_gateways / upnp_mappings   read-only UPnP IGD port-forward audit of the site's gateway(s)
--  * wifi_links / wifi_networks / wifi_link_samples   the collector host's Wi-Fi link and nearby networks
--  * device_banner_probes / device_banners   light HTTP/HTTPS banner probe (at most once a day per device)
--  * dhcp_fingerprints     DHCP option 55 / 60 fingerprints overheard by the passive DHCP listener
--  * security_expected     one-click "this is expected" decisions (DHCP server, Wi-Fi BSSID, UPnP mapping)
--  * security_findings     current and past findings with their evidence
-- Every table carries organization_id and is isolated by Row Level Security.

CREATE TABLE smart_check_runs (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  collector_id    uuid NOT NULL,
  check_kind      text NOT NULL CHECK (check_kind IN ('rogue_dhcp', 'upnp', 'wifi', 'banners', 'dhcp_fingerprints')),
  run_id          uuid NOT NULL,
  trigger         text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  ok              boolean NOT NULL,
  error_kind      text,
  error           text,
  duration_ms     integer,
  summary         jsonb NOT NULL DEFAULT '{}',
  ran_at          timestamptz NOT NULL,
  PRIMARY KEY (organization_id, collector_id, check_kind),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE smart_check_requests (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  check_kind      text NOT NULL CHECK (check_kind IN ('rogue_dhcp', 'upnp', 'wifi', 'banners')),
  requested_at    timestamptz NOT NULL,
  requested_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, site_id, check_kind),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE dhcp_servers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id              uuid NOT NULL,
  -- Server identifier (option 54), or the source address when a server omits it.
  server_id            inet NOT NULL,
  source_ip            inet,
  server_mac           macaddr,
  offered_ip           inet,
  subnet_mask          inet,
  routers              inet[] NOT NULL DEFAULT '{}',
  dns_servers          inet[] NOT NULL DEFAULT '{}',
  lease_seconds        integer,
  domain               text,
  interfaces           text[] NOT NULL DEFAULT '{}',
  -- 'baseline': the only server answering the very first probe at this site (assumed expected until confirmed).
  baseline             boolean NOT NULL DEFAULT false,
  -- Why it is expected (NULL = not expected): 'admin' (approved), 'gateway' (it is the site's gateway or
  -- a configured router), 'baseline'. Recomputed on every probe and on every approval.
  expected             text CHECK (expected IN ('admin', 'gateway', 'baseline')),
  first_seen_at        timestamptz NOT NULL,
  last_offer_at        timestamptz,
  missed_probes        integer NOT NULL DEFAULT 0,
  rogue_open           boolean NOT NULL DEFAULT false,
  -- Passive evidence: clients overheard requesting a lease from this server (option 54).
  clients_choosing     integer NOT NULL DEFAULT 0,
  last_client_choice_at timestamptz,
  UNIQUE (organization_id, site_id, server_id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE dhcp_probe_state (
  organization_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id              uuid NOT NULL,
  consecutive_no_offer integer NOT NULL DEFAULT 0,
  no_offer_open        boolean NOT NULL DEFAULT false,
  probes               integer NOT NULL DEFAULT 0,
  last_probe_at        timestamptz,
  PRIMARY KEY (organization_id, site_id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE upnp_gateways (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id            uuid NOT NULL,
  collector_id       uuid,
  address            inet NOT NULL,
  device_id          uuid,
  friendly_name      text,
  manufacturer       text,
  model              text,
  service_type       text,
  external_ip        inet,
  mappings_truncated boolean NOT NULL DEFAULT false,
  last_error         text,
  first_seen_at      timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  UNIQUE (organization_id, site_id, address),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE upnp_mappings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id          uuid NOT NULL,
  gateway_id       uuid NOT NULL REFERENCES upnp_gateways (id) ON DELETE CASCADE,
  protocol         text NOT NULL CHECK (protocol IN ('TCP', 'UDP')),
  external_port    integer NOT NULL CHECK (external_port BETWEEN 0 AND 65535),
  remote_host      text NOT NULL DEFAULT '',
  internal_client  inet NOT NULL,
  internal_port    integer NOT NULL CHECK (internal_port BETWEEN 0 AND 65535),
  description      text,
  enabled          boolean NOT NULL DEFAULT true,
  lease_seconds    integer,
  device_id        uuid,
  risk             text NOT NULL CHECK (risk IN ('critical', 'warning', 'info')),
  risk_reason      text NOT NULL,
  first_seen_at    timestamptz NOT NULL,
  last_seen_at     timestamptz NOT NULL,
  UNIQUE (gateway_id, protocol, external_port, remote_host),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE wifi_links (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  collector_id    uuid NOT NULL,
  platform        text NOT NULL,
  interface       text,
  connected       boolean NOT NULL,
  ssid            text,
  bssid           macaddr,
  band            text,
  channel         integer,
  frequency_mhz   integer,
  signal_pct      integer,
  rssi_dbm        integer,
  rx_mbps         real,
  tx_mbps         real,
  security        text,
  auth            text,
  cipher          text,
  phy             text,
  -- The channel analysis computed when this link was reported (modules/security/wifi-analysis.ts).
  analysis        jsonb NOT NULL DEFAULT '{}',
  observed_at     timestamptz NOT NULL,
  PRIMARY KEY (organization_id, collector_id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE wifi_link_samples (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  collector_id    uuid NOT NULL,
  ts              timestamptz NOT NULL,
  signal_pct      integer,
  rssi_dbm        integer,
  rx_mbps         real,
  tx_mbps         real,
  channel         integer,
  PRIMARY KEY (organization_id, collector_id, ts),
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE wifi_networks (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  collector_id    uuid NOT NULL,
  bssid           macaddr NOT NULL,
  ssid            text NOT NULL DEFAULT '',
  channel         integer,
  band            text,
  frequency_mhz   integer,
  signal_pct      integer,
  rssi_dbm        integer,
  security        text,
  auth            text,
  cipher          text,
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  PRIMARY KEY (organization_id, collector_id, bssid),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE device_banner_probes (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  device_id       uuid NOT NULL,
  last_probed_at  timestamptz NOT NULL,
  PRIMARY KEY (organization_id, device_id),
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE device_banners (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  device_id       uuid NOT NULL,
  port            integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  ip              inet NOT NULL,
  scheme          text NOT NULL CHECK (scheme IN ('http', 'https')),
  status          integer,
  title           text,
  server          text,
  tls_subject     text,
  tls_issuer      text,
  tls_self_signed boolean,
  probed_at       timestamptz NOT NULL,
  PRIMARY KEY (organization_id, device_id, port),
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE dhcp_fingerprints (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  mac             macaddr NOT NULL,
  prl             text NOT NULL,
  vendor_class    text,
  hostname        text,
  server_id       inet,
  os_family       text,
  confidence      text CHECK (confidence IN ('high', 'medium', 'low')),
  seen_at         timestamptz NOT NULL,
  PRIMARY KEY (organization_id, site_id, mac),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE security_expected (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('dhcp_server', 'wifi_bssid', 'upnp_mapping')),
  value           text NOT NULL CHECK (length(value) BETWEEN 1 AND 120),
  note            text CHECK (note IS NULL OR length(note) <= 200),
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, site_id, kind, value),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE security_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  category        text NOT NULL CHECK (category IN ('dhcp', 'upnp', 'wifi')),
  kind            text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title           text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',
  device_id       uuid,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  resolved_at     timestamptz,
  resolution      text,
  -- "I have seen this" (the finding stays open until the condition is gone or someone resolves it).
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users (id) ON DELETE SET NULL,
  UNIQUE (organization_id, site_id, kind, key),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX security_findings_open_idx ON security_findings (organization_id, site_id, status, severity);
CREATE INDEX wifi_link_samples_time_idx ON wifi_link_samples (organization_id, collector_id, ts DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'smart_check_runs', 'smart_check_requests', 'dhcp_servers', 'dhcp_probe_state', 'upnp_gateways', 'upnp_mappings',
    'wifi_links', 'wifi_link_samples', 'wifi_networks', 'device_banner_probes', 'device_banners', 'dhcp_fingerprints',
    'security_expected', 'security_findings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;

-- Incidents for DHCP (a rogue DHCP server, or no DHCP server answering). The kind list is extended
-- from whatever the constraint allows at this point, so kinds added by earlier migrations are kept.
DO $$
DECLARE kinds text[];
BEGIN
  SELECT array_agg(DISTINCT m[1]) INTO kinds
    FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS m
   WHERE c.conrelid = 'incidents'::regclass AND c.conname = 'incidents_kind_check';
  kinds := ARRAY(SELECT DISTINCT k FROM unnest(coalesce(kinds, ARRAY['network', 'service', 'collector', 'device']) || ARRAY['dhcp']) AS k ORDER BY k);
  ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_kind_check;
  EXECUTE format('ALTER TABLE incidents ADD CONSTRAINT incidents_kind_check CHECK (kind = ANY (%L::text[]))', kinds);
END $$;
