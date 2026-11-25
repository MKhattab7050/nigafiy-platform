-- Internet pauses enforced on the router (docs/features/router-controls.md, "Pause on the router").
--
-- A pause (a device's own, or its access profile's) is first a DNS-filter rule, which only stops
-- devices that use the filter as their DNS server. When the device's site has a connected router
-- that can block devices, the pause also blocks the device's MAC address on that router, and lifts
-- that block when the pause ends or is resumed. One row per (router, device MAC) while Nigafiy
-- manages such a block. The API's `router-pauses` job (and the pause request itself) queue the
-- router's own block through the normal path (router_requests → collector → driver).
--
--  * block_request_id    the block request queued for the pause: its block is the pause's own. A
--                        block an administrator made (or one already on the router) is never lifted.
--  * unblock_request_id  the unblock request queued for that block.
--  * overridden_until    the pause's block was lifted by hand during the pause: do not block again
--                        before the pause ends.
--  * acted_by            who paused (the router requests are made on their behalf); null for an
--                        automation (playbook) pause.

CREATE TABLE router_pause_blocks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id            uuid NOT NULL,
  router_id          uuid NOT NULL,
  device_id          uuid,
  mac                macaddr NOT NULL,
  acted_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  acted_by_email     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  block_request_id   uuid,
  unblock_request_id uuid,
  overridden_until   timestamptz,
  last_attempt_at    timestamptz,
  last_error         text,
  UNIQUE (router_id, mac),
  FOREIGN KEY (organization_id, router_id) REFERENCES site_routers (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX router_pause_blocks_device_idx ON router_pause_blocks (organization_id, device_id);

ALTER TABLE router_pause_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON router_pause_blocks FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON router_pause_blocks TO lan_app;
