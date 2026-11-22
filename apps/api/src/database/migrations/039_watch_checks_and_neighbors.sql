-- Watch check types, CDP / MikroTik neighbours, MNDP listener status.
--
-- 1. monitoring_checks gains four kinds next to icmp / tcp / dns:
--      http / https  one request (GET or HEAD) with an expected status (single or range), optional
--                    body assertion (substring or regex over at most 256 KiB), redirect policy, TLS
--                    verification (on by default) and an optional pinned SHA-256 of the certificate
--      tls_expiry    days until the certificate at host:port expires, warning/critical thresholds
--      snmp_oid      one OID read from a device already configured in Port Detective (its sealed
--                    credentials are reused), compared against warning/critical thresholds
--    Their settings live in `config` (validated by the API: modules/monitoring/kinds.ts). snmp_oid
--    references its SNMP target with a real foreign key so deleting the switch deletes the check.
--    Measured values (TLS days remaining, the OID value, the HTTP status) go to check_results.value and
--    monitoring_checks.last_value; the evidence of the last sample (certificate issuer / subject /
--    notAfter, final URL, raw OID value) to monitoring_checks.last_details.
--
-- 2. Neighbours: switch_ports.neighbors (jsonb) entries now carry a `protocol` ('lldp', 'cdp',
--    'mikrotik'); entries written before this migration are LLDP. MikroTik Neighbor Discovery
--    (MNDP) announcements heard passively by a collector are stored in mndp_neighbors, and the
--    listener's state (listening / bind error / turned off) in collectors.mndp_status. A site can turn
--    the listener off for all its collectors (sites.mndp_listen).

DO $$
DECLARE c record;
BEGIN
  -- The kind list and the "only TCP has a port" rule were unnamed CHECK constraints in 001.
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'monitoring_checks'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE monitoring_checks DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE monitoring_checks
  ADD COLUMN config         jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN snmp_target_id uuid,
  ADD COLUMN last_value     double precision,
  ADD COLUMN last_details   jsonb;

ALTER TABLE monitoring_checks
  ADD CONSTRAINT monitoring_checks_kind_check CHECK (kind IN ('icmp', 'tcp', 'dns', 'http', 'https', 'tls_expiry', 'snmp_oid')),
  ADD CONSTRAINT monitoring_checks_port_by_kind CHECK (
    CASE kind
      WHEN 'tcp' THEN port IS NOT NULL
      WHEN 'tls_expiry' THEN port IS NOT NULL
      WHEN 'http' THEN true
      WHEN 'https' THEN true
      ELSE port IS NULL
    END),
  ADD CONSTRAINT monitoring_checks_snmp_target_by_kind CHECK ((kind = 'snmp_oid') = (snmp_target_id IS NOT NULL)),
  ADD CONSTRAINT monitoring_checks_config_object CHECK (jsonb_typeof(config) = 'object'),
  ADD CONSTRAINT monitoring_checks_snmp_target_fk FOREIGN KEY (organization_id, snmp_target_id)
    REFERENCES snmp_targets (organization_id, id) ON DELETE CASCADE;
CREATE INDEX monitoring_checks_snmp_target_idx ON monitoring_checks (snmp_target_id) WHERE snmp_target_id IS NOT NULL;

ALTER TABLE check_results ADD COLUMN value double precision;
ALTER TABLE check_results_hourly
  ADD COLUMN value_avg double precision,
  ADD COLUMN value_min double precision,
  ADD COLUMN value_max double precision;

-- ───────────────────────── neighbours ─────────────────────────

ALTER TABLE sites ADD COLUMN mndp_listen boolean NOT NULL DEFAULT true;
ALTER TABLE collectors ADD COLUMN mndp_status jsonb;

CREATE TABLE mndp_neighbors (
  collector_id    uuid NOT NULL,
  mac             macaddr NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  -- Inventory device of the same site with this MAC (or, failing that, this IPv4 address).
  device_id       uuid,
  identity        text,
  platform        text,
  version         text,
  board           text,
  interface_name  text,
  ipv4            inet,
  ipv6            inet,
  uptime_seconds  bigint,
  -- The address the announcement came from (the collector only keeps announcements from authorized scopes).
  source_ip       inet,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL,
  PRIMARY KEY (collector_id, mac),
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX mndp_neighbors_site_idx ON mndp_neighbors (site_id, last_seen_at DESC);
CREATE INDEX mndp_neighbors_device_idx ON mndp_neighbors (device_id) WHERE device_id IS NOT NULL;

ALTER TABLE mndp_neighbors ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mndp_neighbors FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON mndp_neighbors TO lan_app;
