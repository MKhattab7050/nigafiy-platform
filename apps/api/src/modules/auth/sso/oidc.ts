import { createHash, timingSafeEqual } from 'node:crypto';
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose';
import { randomToken } from '../../../common/crypto.ts';
import { SsoError, assertIdpUrl } from './config.ts';

/**
 * OpenID Connect relying party: authorization code flow with PKCE (S256), state and nonce.
 *
 * - The provider's discovery document (`<issuer>/.well-known/openid-configuration`) supplies the
 *   endpoints; its `issuer` must equal the configured issuer exactly (OIDC Discovery §4.3).
 * - The ID token is verified with `jose` against the provider's JWKS: signature (RS256 or ES256
 *   only, never "none"/HMAC), `iss`, `aud` (and `azp` when several audiences), `exp`/`iat`
 *   (60 s clock tolerance) and the `nonce` this attempt generated.
 * - The client secret, when there is one, goes to the token endpoint only (client_secret_basic,
 *   or client_secret_post when the provider supports only that).
 */

export const OIDC_ALGORITHMS = ['RS256', 'ES256'];
const FETCH_TIMEOUT_MS = 10_000;

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

const discoveryCache = new Map<string, { at: number; doc: OidcDiscovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const DISCOVERY_TTL_MS = 10 * 60_000;

async function fetchJson(url: URL, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new SsoError('idp_unreachable', `Could not reach ${url.origin}`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SsoError('idp_bad_response', `${url.origin} did not answer with JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = (body as { error?: unknown })?.error;
    throw new SsoError('idp_rejected', `The identity provider answered HTTP ${res.status}${typeof err === 'string' ? ` (${err.slice(0, 80)})` : ''}`);
  }
  return body;
}

export async function discover(issuer: string, { fresh = false } = {}): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (!fresh && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;
  const base = assertIdpUrl(issuer, 'The issuer');
  const url = new URL(`${base.href.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  const doc = (await fetchJson(url)) as Partial<OidcDiscovery>;
  if (doc.issuer !== issuer) throw new SsoError('idp_misconfigured', 'The discovery document names a different issuer');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[key] !== 'string') throw new SsoError('idp_misconfigured', `The discovery document has no ${key}`);
    assertIdpUrl(doc[key], key);
  }
  if (doc.code_challenge_methods_supported && !doc.code_challenge_methods_supported.includes('S256')) {
    throw new SsoError('idp_misconfigured', 'The identity provider does not support PKCE with S256');
  }
  const full = doc as OidcDiscovery;
  discoveryCache.set(issuer, { at: Date.now(), doc: full });
  return full;
}

function jwksFor(uri: string) {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri), { timeoutDuration: FETCH_TIMEOUT_MS, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    jwksCache.set(uri, set);
  }
  return set;
}

export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

export interface OidcClient {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  scopes: string;
}

export async function authorizationUrl(client: OidcClient, p: { state: string; nonce: string; codeVerifier: string; redirectUri: string; loginHint?: string }): Promise<string> {
  const doc = await discover(client.issuer);
  const url = new URL(doc.authorization_endpoint);
  const scopes = new Set(client.scopes.split(/\s+/).filter(Boolean));
  scopes.add('openid');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', [...scopes].join(' '));
  url.searchParams.set('state', p.state);
  url.searchParams.set('nonce', p.nonce);
  url.searchParams.set('code_challenge', pkceChallenge(p.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint) url.searchParams.set('login_hint', p.loginHint);
  return url.toString();
}

const safeStringEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** Exchanges the code and returns the verified ID token claims. */
export async function exchangeCode(
  client: OidcClient,
  p: { code: string; codeVerifier: string; redirectUri: string; nonce: string },
): Promise<JWTPayload> {
  const doc = await discover(client.issuer);
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  if (client.clientSecret && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
    form.set('client_id', client.clientId);
    form.set('client_secret', client.clientSecret);
  } else if (client.clientSecret) {
    // RFC 6749 §2.3.1: both parts form-urlencoded before base64.
    const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  } else {
    form.set('client_id', client.clientId);
  }
  const tokens = (await fetchJson(new URL(doc.token_endpoint), { method: 'POST', headers, body: form })) as { id_token?: unknown };
  if (typeof tokens.id_token !== 'string') throw new SsoError('idp_bad_response', 'The token response has no ID token');

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(tokens.id_token, jwksFor(doc.jwks_uri), {
      issuer: client.issuer,
      audience: client.clientId,
      algorithms: OIDC_ALGORITHMS,
      clockTolerance: 60,
      requiredClaims: ['sub', 'exp', 'iat'],
    }));
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown';
    throw new SsoError('invalid_id_token', `The ID token was rejected (${code})`);
  }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== client.clientId) {
    throw new SsoError('invalid_id_token', 'The ID token was issued to another party (azp)');
  }
  if (typeof payload.nonce !== 'string' || !safeStringEqual(payload.nonce, p.nonce)) {
    throw new SsoError('invalid_id_token', 'The ID token nonce does not match this sign-in');
  }
  return payload;
}

export const newNonce = (): string => randomToken(24);
export const newCodeVerifier = (): string => randomToken(48);

/** Test hook: forget cached discovery documents and key sets. */
export function resetOidcCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}
