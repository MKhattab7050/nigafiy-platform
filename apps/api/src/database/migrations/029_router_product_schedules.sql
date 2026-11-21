-- Schedules LAN Detective enforces itself (docs/features/router-controls.md, "Schedules").
--
-- Some routers cannot schedule a device's internet themselves (no driver support, or — like Zyxel
-- with EasyMesh on — the router ignores its own parental control), but can block a device. For
-- those, the administrator's weekly windows are stored here and the API's `router-schedules` job
-- queues the router's own block at the start of a window and lifts it at the end, through the
-- normal path (router_requests → collector_commands → collector → driver). It works only while the
-- API and a collector of the site are running; the product says so wherever it offers it.
--
--  * windows            [{days: [0..6, 0 = Sunday], start: "HH:MM", end: "HH:MM"}], blocked periods
--                       in wall-clock time of `timezone`; end <= start crosses midnight.
--  * block_request_id   the block request the job queued (its block is the schedule's own; a block
--                       an administrator made is never lifted by a schedule).
--  * unblock_request_id the unblock request the job queued for that block.
--  * paused_until       an administrator lifted the schedule's block during a window: the schedule
--                       does not block again before the end of that window.
--  * removing           the schedule was removed while its block was in effect: the job lifts the
--                       block, then deletes the row.

CREATE TABLE router_product_schedules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  site_id            uuid NOT NULL,
  router_id          uuid NOT NULL,
  device_id          uuid,
  mac                macaddr NOT NULL,
  windows            jsonb NOT NULL CHECK (jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) BETWEEN 1 AND 8),
  timezone           text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_email   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  block_request_id   uuid,
  unblock_request_id uuid,
  paused_until       timestamptz,
  removing           boolean NOT NULL DEFAULT false,
  last_attempt_at    timestamptz,
  last_error         text,
  UNIQUE (router_id, mac),
  FOREIGN KEY (organization_id, router_id) REFERENCES site_routers (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX router_product_schedules_org_idx ON router_product_schedules (organization_id, router_id);

ALTER TABLE router_product_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON router_product_schedules FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON router_product_schedules TO lan_app;
