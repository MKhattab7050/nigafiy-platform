-- Router control: the site's routers (gateways, firewalls, access points) read and — on an explicit
-- administrator action only — controlled through the site's collector.
--
--  * site_routers     one router of a site. The administrator credentials are sealed with the
--                     application key (AES-256-GCM, like SNMP credentials) and are never returned
--                     by the API; they are decrypted only for the configuration of the site's own
--                     collector. TLS trust is explicit: https (system roots), https-pinned (a
--                     certificate fingerprint the administrator confirmed — trust on first use), or
--                     http (explicit opt-in).
--  * router_clients   the latest client list the router reported, linked to a device by MAC
--                     (an inferred link).
--  * router_blocks    the ledger of blocks: who applied which block when, and whether the block was
--                     already in effect before LAN Detective acted. Only blocks LAN Detective applied
--                     itself (pre_existing = false) can be lifted from the product.
--  * router_requests  every administrator request sent to a collector (refresh, certificate fetch,
--                     block, unblock, rate limit, schedule) and its outcome.

CREATE TABLE site_routers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id                  uuid NOT NULL,
  -- The router's own device record (same site, same IP) — an inferred link.
  device_id                uuid,
  name                     text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  vendor                   text NOT NULL CHECK (vendor ~ '^[a-z][a-z0-9_-]{1,30}$'),
  address                  inet NOT NULL,
  port                     integer CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  transport                text NOT NULL CHECK (transport IN ('https', 'https-pinned', 'http')),
  -- Colon-separated upper-case hex SHA-256 of the DER certificate (https-pinned).
  pin_sha256               text CHECK (pin_sha256 IS NULL OR pin_sha256 ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){31}$'),
  pinned_at                timestamptz,
  pinned_by                uuid REFERENCES users (id) ON DELETE SET NULL,
  -- AES-256-GCM JSON { username, password }. Write-only.
  secret_enc               text NOT NULL,
  credentials_updated_at   timestamptz NOT NULL DEFAULT now(),
  enabled                  boolean NOT NULL DEFAULT true,
  refresh_interval_seconds integer NOT NULL DEFAULT 300 CHECK (refresh_interval_seconds BETWEEN 120 AND 86400),
  status                   text NOT NULL DEFAULT 'never'
                           CHECK (status IN ('never', 'ok', 'unreachable', 'login_failed', 'locked_out', 'certificate', 'not_authorized', 'error')),
  last_error               text,
  last_error_kind          text,
  last_checked_at          timestamptz,
  last_ok_at               timestamptz,
  -- Lockout protection: while set and in the future (or 'infinity' for rejected credentials), the
  -- router is left out of the collector configuration and no login-requiring request is accepted.
  -- Cleared when the administrator replaces the credentials.
  login_paused_until       timestamptz,
  login_paused_reason      text CHECK (login_paused_reason IS NULL OR login_paused_reason IN ('bad_credentials', 'locked_out')),
  identity                 jsonb,
  capabilities             jsonb,
  -- The blocks in effect on the router at the last refresh (incl. the administrator's own rules).
  blocked_entries          jsonb,
  clients_refreshed_at     timestamptz,
  -- Trust on first use: the certificate the collector fetched, waiting for the administrator to confirm.
  fetched_certificate      jsonb,
  certificate_fetched_at   timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (site_id, address),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX site_routers_site_idx ON site_routers (organization_id, site_id);

CREATE TABLE router_clients (
  router_id               uuid NOT NULL,
  mac                     macaddr NOT NULL,
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id                 uuid NOT NULL,
  -- Device of the same site with this MAC (inferred link).
  device_id               uuid,
  ip                      inet,
  hostname                text,
  connection              text NOT NULL DEFAULT 'unknown',
  interface               text,
  signal_dbm              integer,
  active                  boolean,
  lease_source            text,
  lease_remaining_seconds bigint,
  blocked                 boolean,
  raw                     jsonb NOT NULL DEFAULT '{}',
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (router_id, mac),
  FOREIGN KEY (organization_id, router_id) REFERENCES site_routers (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX router_clients_mac_idx ON router_clients (organization_id, mac);
CREATE INDEX router_clients_device_idx ON router_clients (device_id) WHERE device_id IS NOT NULL;

CREATE TABLE router_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id              uuid NOT NULL,
  router_id            uuid NOT NULL,
  collector_id         uuid NOT NULL,
  action               text NOT NULL CHECK (action IN ('refresh', 'fetch_certificate', 'block', 'unblock', 'rate_limit', 'clear_rate_limit', 'schedule', 'clear_schedule')),
  mac                  macaddr,
  device_id            uuid,
  params               jsonb NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  result               jsonb,
  error                text,
  error_kind           text,
  created_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_email     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  FOREIGN KEY (organization_id, router_id) REFERENCES site_routers (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, collector_id) REFERENCES collectors (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX router_requests_router_idx ON router_requests (router_id, created_at DESC);
CREATE INDEX router_requests_pending_idx ON router_requests (organization_id, created_at) WHERE status = 'pending';

CREATE TABLE router_blocks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id           uuid NOT NULL,
  router_id         uuid NOT NULL,
  mac               macaddr NOT NULL,
  device_id         uuid,
  request_id        uuid,
  mechanism         text,
  -- true: the device was already blocked on the router before LAN Detective acted (the
  -- administrator's own block). Such a row is a record only: the product never lifts it.
  pre_existing      boolean NOT NULL,
  applied_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  applied_by_email  text,
  applied_at        timestamptz NOT NULL,
  undo              text,
  released_at       timestamptz,
  released_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  released_by_email text,
  -- 'product': lifted from LAN Detective; 'router': no longer in effect at a refresh (lifted on the router itself).
  released_via      text CHECK (released_via IS NULL OR released_via IN ('product', 'router')),
  FOREIGN KEY (organization_id, router_id) REFERENCES site_routers (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
-- At most one open ledger entry per router and MAC.
CREATE UNIQUE INDEX router_blocks_open_idx ON router_blocks (router_id, mac) WHERE released_at IS NULL;
CREATE INDEX router_blocks_device_idx ON router_blocks (device_id) WHERE device_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_routers', 'router_clients', 'router_requests', 'router_blocks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO lan_app USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lan_app', t);
  END LOOP;
END $$;

ALTER TABLE collector_commands DROP CONSTRAINT collector_commands_kind_check;
ALTER TABLE collector_commands ADD CONSTRAINT collector_commands_kind_check
  CHECK (kind IN ('run_discovery', 'run_checks', 'wake_device', 'poll_snmp', 'run_tool',
                  'router_refresh', 'router_fetch_certificate', 'router_block', 'router_unblock', 'router_rate_limit', 'router_schedule'));
