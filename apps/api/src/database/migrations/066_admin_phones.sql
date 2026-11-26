-- Admin phones (docs/roadmap/2026-11-26-admin-phones.md). A phone connected in Fleet is either a
-- regular user's phone (today's behaviour) or an admin phone: the Nigafiy dashboard inside the phone
-- app, with the permissions of the admin who made it one, and the network's important alerts.
--   phone_role          — 'user' or 'admin'; admin only for Android endpoints.
--   phone_admin_user_id — the admin the phone acts as. Their membership is re-checked on every
--                         request, so an admin who loses the role takes the phone's rights with them.
ALTER TABLE endpoints
  ADD COLUMN phone_role text NOT NULL DEFAULT 'user' CHECK (phone_role IN ('user', 'admin')),
  ADD COLUMN phone_admin_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT endpoints_admin_phone_is_android CHECK (phone_role = 'user' OR platform = 'android');

-- A dashboard session opened by an admin phone. It works only while that endpoint is active, still an
-- admin phone and still acting as the same user (auth/session.ts); revoking or demoting ends it.
ALTER TABLE sessions
  ADD COLUMN endpoint_id uuid REFERENCES endpoints (id) ON DELETE CASCADE;
CREATE INDEX sessions_endpoint_idx ON sessions (endpoint_id) WHERE endpoint_id IS NOT NULL;
