# Enterprise single sign-on (OIDC and SAML 2.0)

Each organization can add identity providers next to local email + password sign-in. Local sign-in
keeps working; SSO is an additional way in, per organization.

## What it does

- **OpenID Connect**: authorization code flow with PKCE (S256), `state` and `nonce`. Endpoints come
  from the provider's discovery document (`<issuer>/.well-known/openid-configuration`), whose
  `issuer` must equal the configured issuer exactly. The ID token is verified with `jose` against the
  provider's JWKS: RS256 or ES256 only (never `none` or HMAC), `iss`, `aud` (and `azp` when there are
  several audiences), `exp` / `iat` with 60 s tolerance, and the nonce of this attempt. The client
  secret (optional; public clients work with PKCE alone) is sent only to the token endpoint.
- **SAML 2.0**: SP-initiated Web SSO on `@node-saml/node-saml`. The AuthnRequest goes out by
  HTTP-Redirect (default) or HTTP-POST; the Response comes back by HTTP-POST to the ACS (the Web SSO
  profile does not allow a Response over Redirect). Enforced on every Response:
  - an XML signature over the Response or the Assertion, verified with the IdP certificate stored
    for this provider only; certificates carried in the message (KeyInfo) are ignored;
  - Issuer = configured IdP entity ID; AudienceRestriction contains our SP entity ID;
  - `NotBefore` / `NotOnOrAfter` of Conditions and SubjectConfirmationData (60 s skew);
  - `InResponseTo` = the AuthnRequest ID of this very attempt (single use);
  - a bearer SubjectConfirmation whose `Recipient` is our ACS URL (node-saml 5.2 only logs a
    mismatch, so Nigafiy checks it itself on the verified assertion);
  - replayed assertion IDs are refused until they expire.
- **XML signature wrapping defences**: the profile is read only from the element the signature
  covers; a document with more than one Assertion is refused. Tests cover an unsigned victim
  assertion placed before a signed one, a signed assertion hidden inside `samlp:Extensions`, an
  unsigned assertion nested inside a signed one, and content changed after signing.
- **Browser binding**: every attempt sets an HttpOnly `ld_sso` cookie (path `/api/v1/auth/sso`, 10
  minutes); the callback / ACS / finish step must come from the same browser. A SAML Response is
  verified at the ACS and then completed by `GET /finish` in the browser that started it.
- **Users**: the email must be present, valid, verified (when the IdP says so) and in one of the
  provider's allowed email domains. A known subject (`user_identities`) wins, otherwise the email
  matches an existing user. The user must be an active member of the provider's organization, or
  JIT provisioning must be on. JIT only creates brand-new users (with an unguessable local password;
  "Forgot password" can set one); it never attaches an existing account to the organization — that
  needs an invitation accepted with the account's password.
- **Roles**: an optional attribute → role mapping (viewer / technician / admin; never owner) is
  applied on every sign-in, highest match wins, never to an owner. New JIT users get the mapped role
  or the provider's default role. Role changes are audited (`sso.role_synced`).
- **Pinned sessions**: a session opened by SSO is pinned to that provider's organization; it ends
  when the provider is disabled or deleted, and cannot be switched to another organization.
- **Sign-in page**: typing an email shows "Sign in with <provider>" buttons for providers whose
  allowed domains match (`GET /auth/sso/discover`, returns name and kind only). Errors come back as
  `/login?sso_error=<code>` with a localized message.
- **Settings → Identity providers** (owner / admin only, EN + AR): create, edit, enable/disable,
  delete, and "Check" (OIDC: fetches the discovery document; SAML: certificate validity and the
  sign-in URL; audited as `sso.provider_checked`). Shows the
  redirect URI / ACS URL / SP entity ID and SP metadata URL to give to the IdP administrator.

## MFA policy and SSO

Per provider, `trust_idp_mfa` (default **on**):

- **On (default)** — the identity provider is responsible for MFA. An SSO user is not asked for
  Nigafiy's local TOTP, even when the organization requires MFA (`mfa_required` = admins / all).
  Configure MFA at the IdP (Conditional Access, Okta policies, …). The login audit row records
  `mfa: "identity_provider"`.
- **Off** — Nigafiy's own MFA applies after the IdP: a user with TOTP enrolled must enter a code
  (same replay protection and 5-failure / 15-minute lockout as local sign-in), and a user the
  organization policy requires to use MFA but who has none must enrol before a session is created.
  The session that results is still pinned to the provider.

Local password sign-in is unaffected either way: the organization's MFA policy always applies to it.

## Audit

Written to the provider's organization:

- `auth.sso_login` — every successful SSO sign-in (provider, kind, JIT created, role change, MFA mode);
- `auth.sso_failed` — every failure that can be tied to a provider (reason code, short detail, the
  asserted email when there is one): bad signature, wrong audience / issuer / recipient, expired,
  replayed, wrong request, domain not allowed, not a member, deactivated, unverified email, IdP
  unreachable, …;
- `sso.provider_created` / `sso.provider_updated` / `sso.provider_deleted` / `sso.provider_checked`,
  `sso.user_provisioned`, `sso.role_synced`.

A failure that cannot be tied to any provider (for example an unknown or expired `state` that
matches no attempt) has no organization to write to: it is logged by the API (`sso sign-in failed`,
with the IP) and rate limited, but produces no audit row.

## Secrets and storage

Migration `040_sso_and_search.sql`: `identity_providers`, `user_identities`, `sso_requests`,
`saml_cache`, `sessions.sso_provider_id`, `auth_tokens.sso_provider_id`. The OIDC client secret is
write-only, AES-256-GCM at rest (`oidc_client_secret_enc`), covered by `pnpm rotate-key`, never
returned by the API or written to the audit log. The PKCE verifier of an attempt is also encrypted.
The SAML IdP certificate is public material and stored as PEM.

## Libraries

- `jose` 6.2.15 — JWKS fetching and JWT verification (RS256 / ES256), zero dependencies, widely used.
- `@node-saml/node-saml` 5.2.0 — maintained successor of passport-saml; XML signature verification
  with `xml-crypto`, InResponseTo / replay cache hooks. Writing XML-DSig verification by hand would be
  the riskier choice.

## Verified

- `apps/api/tests/sso.test.ts` with local IdP doubles in `apps/api/tests/sso-idp.ts` (keys generated
  and tokens / assertions signed inside the test): admin CRUD and roles, secret sealing, tenant
  isolation, OIDC JIT + role mapping + pinned session, tampered / foreign / replayed tokens, JIT vs
  existing accounts, `trust_idp_mfa` off with the organization MFA policy, SAML sign-in through the
  finish step, and rejection of unsigned, foreign-signed, wrong audience / issuer / recipient,
  expired, other-request and four signature-wrapping variants — each failure audited.
- `apps/api/tests/rotate-key.test.ts` re-seals the client secret.

## Not verified

- Never run against a real identity provider (Microsoft Entra ID, Okta, Google, Keycloak, ADFS).
  The protocol paths are exercised only against the in-test doubles.
- Single logout (SLO) and IdP-initiated SAML are not implemented (SP-initiated only, by design:
  IdP-initiated responses have no InResponseTo to bind to).
- Encrypted SAML assertions are not configured (no SP decryption key); use a signed assertion over
  HTTPS.
