-- 040: enterprise single sign-on (OIDC and SAML 2.0 identity providers per organization) and global
-- search indexes that match the expressions modules/overview/search.ts filters on.

-- ── 1. Identity providers ──────────────────────────────────────────────────────────────────────
-- One row per external identity provider an organization trusts. Local email + password sign-in
-- keeps working alongside; nothing here replaces it.
CREATE TABLE identity_providers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('oidc', 'saml')),
  name                   text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  enabled                boolean NOT NULL DEFAULT true,
  -- OpenID Connect (authorization code + PKCE). The issuer's discovery document supplies the
  -- endpoints and the JWKS; nothing else is configured by hand.
  oidc_issuer            text CHECK (oidc_issuer IS NULL OR length(oidc_issuer) <= 500),
  oidc_client_id         text CHECK (oidc_client_id IS NULL OR length(oidc_client_id) <= 300),
  -- AES-256-GCM sealed (common/crypto.ts), write-only: no API returns it. Covered by rotate-key.
  oidc_client_secret_enc text,
  oidc_scopes            text NOT NULL DEFAULT 'openid email profile' CHECK (length(oidc_scopes) <= 300),
  -- SAML 2.0 (SP-initiated). The IdP certificate is public; it is what assertions are verified with.
  saml_entry_point       text CHECK (saml_entry_point IS NULL OR length(saml_entry_point) <= 500),
  saml_idp_entity_id     text CHECK (saml_idp_entity_id IS NULL OR length(saml_idp_entity_id) <= 500),
  saml_idp_cert          text CHECK (saml_idp_cert IS NULL OR length(saml_idp_cert) <= 20000),
  saml_request_binding   text NOT NULL DEFAULT 'redirect' CHECK (saml_request_binding IN ('redirect', 'post')),
  -- Claim / attribute names and how they map to Nigafiy.
  email_attribute        text NOT NULL DEFAULT 'email' CHECK (length(email_attribute) BETWEEN 1 AND 200),
  name_attribute         text CHECK (name_attribute IS NULL OR length(name_attribute) BETWEEN 1 AND 200),
  role_attribute         text CHECK (role_attribute IS NULL OR length(role_attribute) BETWEEN 1 AND 200),
  -- [{"value": "<claim value>", "role": "viewer|technician|admin"}]; the highest matching role wins.
  -- "owner" can never be granted by an identity provider.
  role_mapping           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(role_mapping) = 'array'),
  -- Lower-case domains whose users may sign in through this provider (also how the sign-in page
  -- finds the provider from a typed email address). At least one.
  allowed_email_domains  text[] NOT NULL CHECK (cardinality(allowed_email_domains) BETWEEN 1 AND 20),
  -- Create a membership on first sign-in for users the organization has not invited.
  jit_provisioning       boolean NOT NULL DEFAULT false,
  default_role           text NOT NULL DEFAULT 'viewer' CHECK (default_role IN ('viewer', 'technician', 'admin')),
  -- true (default): the identity provider is responsible for MFA; local TOTP is not asked after an
  -- SSO sign-in. false: the organization's local MFA policy and the user's TOTP apply after SSO too.
  trust_idp_mfa          boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (kind <> 'oidc' OR (oidc_issuer IS NOT NULL AND oidc_client_id IS NOT NULL)),
  CHECK (kind <> 'saml' OR (saml_entry_point IS NOT NULL AND saml_idp_entity_id IS NOT NULL AND saml_idp_cert IS NOT NULL))
);
CREATE INDEX identity_providers_domains_idx ON identity_providers USING gin (allowed_email_domains);

ALTER TABLE identity_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity_providers FOR ALL TO lan_app
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_providers TO lan_app;

-- Which external subject (OIDC "sub" / SAML NameID) is which Nigafiy user. Identity table: like
-- users and sessions, only the system role reads it (no grant to lan_app).
CREATE TABLE user_identities (
  provider_id     uuid NOT NULL REFERENCES identity_providers (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  subject         text NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz,
  PRIMARY KEY (provider_id, subject)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- One SP-initiated sign-in attempt. Bound to the browser that started it (binding_hash = SHA-256 of
-- a random value in an HttpOnly cookie), single use, ten minutes. System role only.
CREATE TABLE sso_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       uuid NOT NULL REFERENCES identity_providers (id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  binding_hash      text NOT NULL,
  -- OIDC: the state is this row's id; nonce and the PKCE verifier (sealed) are kept here.
  nonce             text,
  code_verifier_enc text,
  -- SAML: the AuthnRequest ID the Response must answer (InResponseTo).
  saml_request_id   text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  -- Set when the IdP's answer verified; the session is created only when the same browser comes
  -- back with the binding cookie (consumed_at).
  completed_user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  completed_at      timestamptz,
  consumed_at       timestamptz
);
CREATE INDEX sso_requests_expires_idx ON sso_requests (expires_at);

-- node-saml's cache: issued AuthnRequest IDs and the IDs of assertions already accepted (replay
-- protection). System role only.
CREATE TABLE saml_cache (
  key        text PRIMARY KEY CHECK (length(key) <= 600),
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX saml_cache_expires_idx ON saml_cache (expires_at);

-- A session (and a pending MFA step) started through SSO stays pinned to the provider's
-- organization: it cannot switch to another organization the user belongs to, and it ends when
-- the provider is deleted (CASCADE) or disabled (checked on every request).
ALTER TABLE sessions ADD COLUMN sso_provider_id uuid REFERENCES identity_providers (id) ON DELETE CASCADE;
ALTER TABLE auth_tokens ADD COLUMN sso_provider_id uuid REFERENCES identity_providers (id) ON DELETE CASCADE;

-- ── 2. Global search indexes ──────────────────────────────────────────────────────────────────
-- The trigram indexes of migration 020 covered only some of the columns search.ts compared one by
-- one, so the planner could not use them. Each searchable table now has ONE trigram index on the
-- exact expression search.ts filters on (the expressions must stay identical to the query text).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    DROP INDEX IF EXISTS devices_search_trgm;
    DROP INDEX IF EXISTS endpoints_search_trgm;
    CREATE INDEX IF NOT EXISTS devices_search_all_trgm ON devices USING gin ((
      coalesce(display_name, '') || ' ' || coalesce(hostname, '') || ' ' || coalesce(vendor, '') || ' ' || coalesce(owner, '')
      || ' ' || coalesce(host(current_ip), '') || ' ' || coalesce(primary_mac::text, '') || ' ' || coalesce(replace(primary_mac::text, ':', ''), '')
    ) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS endpoints_search_all_trgm ON endpoints USING gin ((
      coalesce(name, '') || ' ' || coalesce(hostname, '') || ' ' || coalesce(serial_number, '')
      || ' ' || coalesce(host(primary_ip), '') || ' ' || coalesce(primary_mac::text, '') || ' ' || coalesce(replace(primary_mac::text, ':', ''), '')
    ) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS snmp_targets_search_trgm ON snmp_targets USING gin ((
      coalesce(name, '') || ' ' || coalesce(sys_name, '') || ' ' || host(host)
    ) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS site_routers_search_trgm ON site_routers USING gin ((
      name || ' ' || vendor || ' ' || host(address)
    ) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS network_scopes_search_trgm ON network_scopes USING gin ((
      coalesce(label, '') || ' ' || text(cidr)
    ) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS ipam_subnets_search_trgm ON ipam_subnets USING gin ((
      coalesce(notes, '') || ' ' || coalesce(host(gateway), '')
    ) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS device_tags_tag_trgm ON device_tags USING gin (tag gin_trgm_ops);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ipam_subnets_vlan_idx ON ipam_subnets (organization_id, vlan_id);
