import { env } from '../../../config/env.ts';

/** Ten minutes from "Sign in with …" to the identity provider's answer. */
export const SSO_REQUEST_TTL_MS = 10 * 60_000;
/** HttpOnly cookie that binds an SSO attempt to the browser that started it. */
export const SSO_BINDING_COOKIE = 'ld_sso';
export const SSO_COOKIE_PATH = '/api/v1/auth/sso';

/**
 * The addresses an identity provider must be configured with. Built from WEB_ORIGIN: the browser
 * reaches the API through the web app's /api proxy, so that is where the IdP sends the user back.
 */
export function serviceProviderUrls(providerId: string) {
  const base = `${env.WEB_ORIGIN.replace(/\/+$/, '')}/api/v1/auth/sso`;
  return {
    oidc_redirect_uri: `${base}/oidc/callback`,
    saml_acs_url: `${base}/saml/acs`,
    saml_entity_id: `${base}/saml/${providerId}/metadata`,
    saml_metadata_url: `${base}/saml/${providerId}/metadata`,
  };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Identity-provider URLs must be https. Plain http is accepted only for a loopback host outside
 * production (a development or test identity provider on this machine).
 */
export function idpUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.username || url.password) return 'must not contain credentials';
  if (url.hash) return 'must not contain a fragment';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && env.NODE_ENV !== 'production') return null;
  return 'must use https';
}

export function assertIdpUrl(value: string, what: string): URL {
  const problem = idpUrlProblem(value);
  if (problem) throw new SsoError('idp_misconfigured', `${what} ${problem}`);
  return new URL(value);
}

/** A failure of one SSO attempt. `code` is safe to show the user and to record in the audit log. */
export class SsoError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Email domains as stored: lower-case, no leading "@", IDN left as typed (punycode works too). */
export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^@+/, '').replace(/\.$/, '');
}

export function emailDomain(email: string): string {
  return normalizeDomain(email.slice(email.lastIndexOf('@') + 1));
}
