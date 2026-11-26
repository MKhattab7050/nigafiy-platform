-- Access from outside home (UX review 2026-11-26, item 18).
--
-- The web app of an installed copy listens on 127.0.0.1 only. To use it away from home the owner
-- puts a private tunnel in front of it, never an opened router port:
--  * Tailscale Serve: https://<pc>.<tailnet>.ts.net, reachable only from the owner's own tailnet;
--  * Cloudflare Tunnel: https://<a hostname of theirs>, ideally behind Cloudflare Access.
-- The browser then sends that origin, and the API's CSRF Origin check (isWebOrigin) must accept it.
-- WEB_EXTRA_ORIGINS still works for administrators who edit .env; these rows are the origins added
-- from Settings → Access from outside home, by the owner, and apply to the whole instance.
--
-- Read and written only through the system pool (no grant to lan_app).

CREATE TABLE web_origins (
  origin           text PRIMARY KEY CHECK (origin ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$'),
  kind             text NOT NULL CHECK (kind IN ('tailscale', 'cloudflare', 'custom')),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  added_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE web_origins ENABLE ROW LEVEL SECURITY;
