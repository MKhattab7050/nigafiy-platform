-- Device controls: approval (trust), alert muting, per-device monitoring and Wake-on-LAN.
--
-- trust:
--   unreviewed — nobody has looked at it yet (every newly discovered device starts here)
--   known      — the owner approved it as belonging on this network
--   unwanted   — the owner flagged it as not allowed; its return raises a critical alert.
--                LAN Detective does not disconnect devices itself: blocking is done on the router.
ALTER TABLE devices
  ADD COLUMN trust text NOT NULL DEFAULT 'unreviewed' CHECK (trust IN ('unreviewed', 'known', 'unwanted')),
  ADD COLUMN trust_changed_at timestamptz,
  ADD COLUMN alerts_muted boolean NOT NULL DEFAULT false;
CREATE INDEX devices_org_trust_idx ON devices (organization_id, trust);

-- A check created from a device follows that device when its IP address changes.
ALTER TABLE monitoring_checks ADD COLUMN device_id uuid;
ALTER TABLE monitoring_checks
  ADD CONSTRAINT monitoring_checks_device_fk FOREIGN KEY (organization_id, device_id) REFERENCES devices (organization_id, id) ON DELETE CASCADE;
CREATE INDEX monitoring_checks_device_idx ON monitoring_checks (device_id) WHERE device_id IS NOT NULL;

-- Commands may carry parameters. Still a closed list: wake_device sends a Wake-on-LAN packet and nothing else.
ALTER TABLE collector_commands ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
ALTER TABLE collector_commands DROP CONSTRAINT collector_commands_kind_check;
ALTER TABLE collector_commands ADD CONSTRAINT collector_commands_kind_check CHECK (kind IN ('run_discovery', 'run_checks', 'wake_device'));
