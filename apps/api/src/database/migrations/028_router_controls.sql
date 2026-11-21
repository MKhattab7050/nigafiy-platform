-- Router controls beyond block / unblock (docs/features/router-controls.md): overview, Wi-Fi on/off,
-- DHCP reservations, port forwarding, rename on the router, reboot. Every one is an explicit
-- administrator request run by the site's collector.
--
--  * site_routers.settings     the router's settings as last read (overview, wifi, reservations,
--                              port_forwards). Each part a read reports replaces the stored part; a
--                              part a read does not report keeps its last known value. Never holds a
--                              Wi-Fi key, a RADIUS secret or any password (the collector never sends them).
--  * site_routers.settings_at  when a part of it was last stored.

ALTER TABLE site_routers ADD COLUMN IF NOT EXISTS settings jsonb;
ALTER TABLE site_routers ADD COLUMN IF NOT EXISTS settings_at timestamptz;

-- router_requests.action: the new request actions. 017 created the check inline, so its name is
-- whatever PostgreSQL generated; every CHECK on router_requests that mentions `action` is replaced.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'router_requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '\maction\M'
  LOOP
    EXECUTE format('ALTER TABLE router_requests DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE router_requests ADD CONSTRAINT router_requests_action_check
  CHECK (action IN ('refresh', 'fetch_certificate', 'block', 'unblock', 'rate_limit', 'clear_rate_limit', 'schedule', 'clear_schedule',
                    'rename', 'wifi', 'reserve', 'unreserve', 'add_port_forward', 'remove_port_forward', 'reboot'));

-- Collector commands for the new controls. Added to whatever the allowed list is at this point
-- (other migrations extend the same list), so no earlier command kind is lost.
DO $$
DECLARE
  def   text;
  kinds text[];
  k     text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'collector_commands_kind_check' AND conrelid = 'collector_commands'::regclass;
  SELECT coalesce(array_agg(DISTINCT m[1]), '{}') INTO kinds FROM regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g') AS m;
  FOREACH k IN ARRAY ARRAY['router_rename', 'router_wifi', 'router_reservation', 'router_port_forward', 'router_reboot'] LOOP
    IF NOT k = ANY (kinds) THEN
      kinds := kinds || k;
    END IF;
  END LOOP;
  ALTER TABLE collector_commands DROP CONSTRAINT IF EXISTS collector_commands_kind_check;
  EXECUTE format('ALTER TABLE collector_commands ADD CONSTRAINT collector_commands_kind_check CHECK (kind IN (%s))',
                 (SELECT string_agg(quote_literal(k2), ', ' ORDER BY k2) FROM unnest(kinds) AS k2));
END $$;
