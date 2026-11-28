-- The computer running Nigafiy keeps the same address on the home network (owner's request 2026-11-28).
--
-- After a router is added and read for the first time, Nigafiy reserves the current address of each
-- of this computer's network adapters on that router (automation router.reserve_own_address).
-- self_reservations remembers, per adapter MAC, what Nigafiy did, so an adapter is handled once per
-- router: a reservation the administrator removes later is never put back.
--   { "<mac>": { "ip": "192.168.1.138", "state": "requested" | "already" | "conflict",
--                "code": "ip_reserved" | "ip_in_use" | null, "request_id": "<uuid>" | null, "at": "<iso time>" } }

ALTER TABLE site_routers ADD COLUMN self_reservations jsonb NOT NULL DEFAULT '{}'::jsonb;
