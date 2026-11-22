import { type CacheProvider, type Profile, SAML, ValidateInResponseTo, generateServiceProviderMetadata } from '@node-saml/node-saml';
import { systemPool } from '../../../infrastructure/db.ts';
import { SSO_REQUEST_TTL_MS, SsoError, assertIdpUrl, serviceProviderUrls } from './config.ts';

/**
 * SAML 2.0 service provider (SP-initiated Web SSO) on `@node-saml/node-saml`.
 *
 * What is enforced, and by whom:
 *  - XML signature over the Response or the Assertion, verified with the IdP certificate configured
 *    for this provider only (KeyInfo in the message is ignored). node-saml then reads the profile
 *    ONLY from the signed element, which is its defence against XML signature wrapping; it also
 *    rejects a document with more than one Assertion and unsigned/encrypted mixtures.
 *  - Issuer must equal the configured IdP entity ID (idpIssuer).
 *  - AudienceRestriction must contain our SP entity ID.
 *  - NotBefore / NotOnOrAfter of Conditions and SubjectConfirmationData (60 s clock skew).
 *  - InResponseTo must be THIS attempt's AuthnRequest ID: the cache provider below answers only
 *    for the request ID recorded on the sso_requests row, and consumes it (single use).
 *  - Replays: every accepted assertion ID is remembered until it expires (rejectReplayedAssertions).
 *  - Recipient: node-saml 5.2 only logs a mismatch, so checkRecipient() below requires a bearer
 *    SubjectConfirmation whose Recipient is our ACS URL, read from the verified assertion.
 *
 * Bindings: the AuthnRequest goes out by HTTP-Redirect (default) or HTTP-POST (per provider); the
 * Response comes back by HTTP-POST to the ACS (the Web SSO profile does not allow a Response over
 * HTTP-Redirect).
 */

export interface SamlProviderRow {
  id: string;
  saml_entry_point: string;
  saml_idp_entity_id: string;
  saml_idp_cert: string;
  saml_request_binding: 'redirect' | 'post';
}

/** PostgreSQL-backed node-saml cache (table saml_cache). */
export function samlCache(opts: { expectRequestId?: string | null; onSave?: (requestId: string) => void } = {}): CacheProvider {
  const reqKey = (k: string) => `req:${k}`;
  const allowed = (k: string) => opts.expectRequestId === undefined || opts.expectRequestId === k;
  return {
    async saveAsync(key, value) {
      await systemPool.query(
        `INSERT INTO saml_cache (key, value, expires_at) VALUES ($1,$2, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [reqKey(key), value, SSO_REQUEST_TTL_MS / 1000],
      );
      opts.onSave?.(key);
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      if (!allowed(key)) return null;
      const r = await systemPool.query<{ value: string }>(`SELECT value FROM saml_cache WHERE key = $1 AND expires_at > now()`, [reqKey(key)]);
      return r.rows[0]?.value ?? null;
    },
    async removeAsync(key) {
      if (key === null) return null;
      const r = await systemPool.query<{ value: string }>(`DELETE FROM saml_cache WHERE key = $1 RETURNING value`, [reqKey(key)]);
      return r.rows[0]?.value ?? null;
    },
    async consumeAsync(key) {
      if (!allowed(key)) return null;
      const r = await systemPool.query<{ value: string }>(`DELETE FROM saml_cache WHERE key = $1 AND expires_at > now() RETURNING value`, [reqKey(key)]);
      return r.rows[0]?.value ?? null;
    },
    async saveIfAbsentAsync(key, value, expiresAtMs) {
      const r = await systemPool.query(
        `INSERT INTO saml_cache (key, value, expires_at) VALUES ($1,$2,to_timestamp($3 / 1000.0))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
          WHERE saml_cache.expires_at <= now()`,
        [`seen:${key}`.slice(0, 600), value, expiresAtMs],
      );
      return r.rowCount === 1;
    },
  };
}

export function samlFor(p: SamlProviderRow, cache: CacheProvider): SAML {
  assertIdpUrl(p.saml_entry_point, 'The SAML sign-in URL');
  const urls = serviceProviderUrls(p.id);
  return new SAML({
    entryPoint: p.saml_entry_point,
    idpCert: p.saml_idp_cert,
    idpIssuer: p.saml_idp_entity_id,
    issuer: urls.saml_entity_id,
    audience: urls.saml_entity_id,
    callbackUrl: urls.saml_acs_url,
    authnRequestBinding: p.saml_request_binding === 'post' ? 'HTTP-POST' : 'HTTP-Redirect',
    // Either the Response or the Assertion must be signed (node-saml refuses neither being signed).
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SSO_REQUEST_TTL_MS,
    rejectReplayedAssertions: true,
    acceptedClockSkewMs: 60_000,
    cacheProvider: cache,
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
  });
}

export async function samlRedirectUrl(p: SamlProviderRow, relayState: string, onRequestId: (id: string) => void): Promise<string> {
  return samlFor(p, samlCache({ onSave: onRequestId })).getAuthorizeUrlAsync(relayState, {});
}

export async function samlPostFields(p: SamlProviderRow, relayState: string, onRequestId: (id: string) => void): Promise<Record<string, string>> {
  const msg = await samlFor(p, samlCache({ onSave: onRequestId })).getAuthorizeMessageAsync(relayState, {});
  return Object.fromEntries(Object.entries(msg).map(([k, v]) => [k, String(v)]));
}

type XmlNode = { $?: Record<string, string>; [k: string]: unknown };
const children = (node: unknown, name: string): XmlNode[] => {
  if (!node || typeof node !== 'object') return [];
  const n = node as Record<string, unknown>;
  const found = n[name] ?? Object.entries(n).find(([k]) => k.endsWith(`:${name}`))?.[1];
  if (Array.isArray(found)) return found as XmlNode[];
  return found && typeof found === 'object' ? [found as XmlNode] : [];
};

/** A bearer SubjectConfirmation of the verified assertion must name our ACS as Recipient. */
export function checkRecipient(profile: Profile, acsUrl: string, now = Date.now()): void {
  const parsed = profile.getAssertion?.() as Record<string, unknown> | undefined;
  const assertion = parsed ? children(parsed, 'Assertion')[0] : undefined;
  const confirmations = children(children(assertion, 'Subject')[0], 'SubjectConfirmation');
  const ok = confirmations.some((c) => {
    if (c.$?.Method !== 'urn:oasis:names:tc:SAML:2.0:cm:bearer') return false;
    return children(c, 'SubjectConfirmationData').some((d) => {
      const recipient = d.$?.Recipient;
      const notOnOrAfter = d.$?.NotOnOrAfter ? Date.parse(d.$.NotOnOrAfter) : Number.NaN;
      return recipient === acsUrl && Number.isFinite(notOnOrAfter) && notOnOrAfter + 60_000 > now;
    });
  });
  if (!ok) throw new SsoError('saml_wrong_recipient', 'The assertion is not addressed to this server (Recipient)');
}

export async function validateSamlResponse(p: SamlProviderRow, expectedRequestId: string, body: Record<string, string>): Promise<Profile> {
  const saml = samlFor(p, samlCache({ expectRequestId: expectedRequestId }));
  let result: { profile: Profile | null; loggedOut: boolean };
  try {
    result = await saml.validatePostResponseAsync(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid';
    throw new SsoError('saml_invalid', `The SAML response was rejected: ${message.replace(/[\r\n]+/g, ' ').slice(0, 160)}`);
  }
  if (!result.profile || result.loggedOut) throw new SsoError('saml_invalid', 'The SAML response carries no sign-in');
  checkRecipient(result.profile, serviceProviderUrls(p.id).saml_acs_url);
  return result.profile;
}

export function spMetadata(providerId: string): string {
  const urls = serviceProviderUrls(providerId);
  return generateServiceProviderMetadata({ issuer: urls.saml_entity_id, callbackUrl: urls.saml_acs_url, identifierFormat: null, wantAssertionsSigned: false });
}
