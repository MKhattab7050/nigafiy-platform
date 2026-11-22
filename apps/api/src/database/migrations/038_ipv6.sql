-- IPv6 across Radar and IPAM (docs/features/ipv6.md).
--
-- 1. device_addresses: every address a device was observed at, IPv4 and IPv6, with how it was
--    observed. devices.current_ip stays the one address the device is identified by (IPv4 when the
--    device has one); a device can hold several IPv6 addresses at once (link-local, unique-local,
--    global, temporary privacy addresses), so they are listed here, never squeezed into one column.

CREATE TABLE device_addresses (
  device_id       uuid NOT NULL,
  organization_id uuid NOT NULL,
  site_id         uuid NOT NULL,
  ip              inet NOT NULL CHECK (masklen(ip) = CASE family(ip) WHEN 4 THEN 32 ELSE 128 END),
  -- ipv4, or the IPv6 class: link_local (fe80::/10, meaningful on one link only), unique_local
  -- (fc00::/7) or global. The same table as common/net.ts addressScope (special-purpose ranges are
  -- never accepted as scopes, so they cannot be observed inside one).
  address_scope   text GENERATED ALWAYS AS (
                    CASE WHEN family(ip) = 4 THEN 'ipv4'
                         WHEN ip <<= inet 'fe80::/10' THEN 'link_local'
                         WHEN ip <<= inet 'fc00::/7' THEN 'unique_local'
                         ELSE 'global' END) STORED,
  -- The scope whose discovery run saw it last (NULL once that scope is removed).
  scope_id        uuid REFERENCES network_scopes (id) ON DELETE SET NULL,
  -- Evidence: how the address was observed (icmp, arp_cache, icmpv6, icmpv6_multicast, ndp_cache,
  -- local_interface, rdns, dhcp, mdns, ssdp, netbios).
  sources         text[] NOT NULL DEFAULT '{}',
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  PRIMARY KEY (device_id, ip),
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX device_addresses_site_ip_idx ON device_addresses (site_id, ip);
CREATE INDEX device_addresses_scope_idx ON device_addresses (scope_id, last_seen_at);

ALTER TABLE device_addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_addresses FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON device_addresses TO lan_app;

-- What was already observed: the current address of every device, and its IPv4 history.
INSERT INTO device_addresses (device_id, organization_id, site_id, ip, sources, first_seen_at, last_seen_at)
SELECT d.id, d.organization_id, d.site_id, h.ip, d.discovery_sources, h.first_seen_at, h.last_seen_at
  FROM device_ip_history h JOIN devices d ON d.id = h.device_id
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    -- Device search matches every observed address (modules/devices/routes.ts, overview/search.ts).
    CREATE INDEX IF NOT EXISTS device_addresses_ip_trgm ON device_addresses USING gin ((host(ip)) gin_trgm_ops);
  END IF;
END $$;
