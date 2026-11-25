-- Android devices as Fleet endpoints (docs/features/android.md).
--
-- 015_remove_mobile_mdm.sql removed an earlier attempt that had no app on the phone. This time the
-- Device Policy Controller is part of the product (agents/android-agent), so 'android' comes back
-- as an endpoint platform ('ios' does not: it needs a paid Apple account).
--
--  * endpoints.android            what the agent reports that only Android has: mode
--                                 (regular | device_owner), SDK level, security patch, battery,
--                                 network kind, camera switch, required screen-lock complexity.
--  * fleet_android_apks           APKs an admin uploaded to push to Device Owner phones: name, size,
--                                 SHA-256 and the bytes (≤ 100 MiB). The agent downloads one only for
--                                 an install command it was given, and checks size and SHA-256.
--  * fleet_android_requests       an Android action that waits for a second admin (wipe, when the
--                                 endpoint's Fleet group asks for approvals). Approving queues the
--                                 command; the requester can never approve their own request.

ALTER TABLE endpoints DROP CONSTRAINT IF EXISTS endpoints_platform_check;
ALTER TABLE endpoints ADD CONSTRAINT endpoints_platform_check CHECK (platform IN ('windows', 'linux', 'macos', 'android'));

ALTER TABLE endpoints ADD COLUMN android jsonb;

CREATE TABLE fleet_android_apks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  file_name         text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  size_bytes        bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content           bytea NOT NULL,
  uploaded_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  uploaded_by_email text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, sha256)
);
ALTER TABLE fleet_android_apks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_android_apks FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, DELETE ON fleet_android_apks TO lan_app;

CREATE TABLE fleet_android_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL,
  action           text NOT NULL CHECK (action IN ('wipe')),
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  requested_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  requested_email  text NOT NULL,
  fleet_group_id   uuid REFERENCES fleet_groups (id) ON DELETE SET NULL,
  policy_trail     jsonb NOT NULL DEFAULT '[]'::jsonb,
  mfa_verified     boolean NOT NULL DEFAULT false,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
  approver_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  approver_email   text,
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  decided_at       timestamptz,
  expires_at       timestamptz NOT NULL,
  command_id       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES endpoints (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX fleet_android_requests_pending_idx ON fleet_android_requests (organization_id, created_at) WHERE state = 'pending';
CREATE INDEX fleet_android_requests_endpoint_idx ON fleet_android_requests (endpoint_id, created_at DESC);
ALTER TABLE fleet_android_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fleet_android_requests FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
-- No DELETE: a request and its decision are evidence.
GRANT SELECT, INSERT, UPDATE ON fleet_android_requests TO lan_app;
