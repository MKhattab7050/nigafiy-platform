-- IP address management (IPAM).
--
-- A subnet is an authorized network scope. What is *observed* (which device answers at which
-- address) already lives in devices / device_ip_history. These tables add what the administrator
-- *documents*: the plan for the subnet and the addresses that are assigned or kept free.
-- Observed and documented facts are never merged: the API reports both and flags disagreements.

ALTER TABLE network_scopes ADD CONSTRAINT network_scopes_org_id_key UNIQUE (organization_id, id);

CREATE TABLE ipam_subnets (
  scope_id        uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  vlan_id         integer CHECK (vlan_id BETWEEN 1 AND 4094),
  gateway         inet,
  dns_servers     inet[] NOT NULL DEFAULT '{}' CHECK (cardinality(dns_servers) <= 4),
  -- The DHCP pool as configured on the router / DHCP server. Entered by hand: LAN Detective does
  -- not read DHCP server configuration.
  dhcp_start      inet,
  dhcp_end        inet,
  notes           text CHECK (notes IS NULL OR length(notes) <= 1000),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  FOREIGN KEY (organization_id, scope_id) REFERENCES network_scopes (organization_id, id) ON DELETE CASCADE,
  CHECK ((dhcp_start IS NULL) = (dhcp_end IS NULL)),
  CHECK (dhcp_start IS NULL OR dhcp_start <= dhcp_end)
);

CREATE TABLE ipam_addresses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id         uuid NOT NULL,
  ip              inet NOT NULL CHECK (family(ip) = 4 AND masklen(ip) = 32),
  -- static:           configured by hand on the machine
  -- dhcp_reservation: the DHCP server always hands this address to one MAC
  -- reserved:         kept free on purpose; nothing should answer here
  kind            text NOT NULL CHECK (kind IN ('static', 'dhcp_reservation', 'reserved')),
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  mac             macaddr,
  notes           text CHECK (notes IS NULL OR length(notes) <= 500),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, ip),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  CHECK (kind <> 'dhcp_reservation' OR mac IS NOT NULL),
  CHECK (kind <> 'reserved' OR mac IS NULL)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ipam_subnets', 'ipam_addresses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;
