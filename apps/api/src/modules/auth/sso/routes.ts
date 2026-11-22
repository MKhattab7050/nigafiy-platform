import express, { type Request, type Response, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { MfaRequirement, SsoDiscoverResponse } from '@lan-detective/shared-types';
import { AppError, parse } from '../../../common/http.ts';
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256 } from '../../../common/crypto.ts';
import { env } from '../../../config/env.ts';
import { type Db, systemPool, withSystem } from '../../../infrastructure/db.ts';
import { logger } from '../../../infrastructure/logger.ts';
import { limiterStore } from '../../../infrastructure/rate-limit.ts';
import { readCookie, createSession } from '../session.ts';
import { SSO_BINDING_COOKIE, SSO_COOKIE_PATH, SSO_REQUEST_TTL_MS, SsoError, emailDomain, serviceProviderUrls } from './config.ts';
import { authorizationUrl, exchangeCode, newCodeVerifier, newNonce } from './oidc.ts';
import { type SamlProviderRow, samlPostFields, samlRedirectUrl, spMetadata, validateSamlResponse } from './saml.ts';
import { type ProviderRow, type ResolvedSsoUser, type SsoClaims, claimValues, resolveSsoUser } from './users.ts';

/**
 * Public SSO routes, mounted at /api/v1/auth/sso:
 *   GET  /discover?email=        providers that accept this email domain (sign-in page buttons)
 *   GET  /:id/start              begin an SP-initiated sign-in (sets the browser-binding cookie)
 *   GET  /oidc/callback          OIDC redirect URI (state = sso_requests.id)
 *   POST /saml/acs               SAML assertion consumer service (HTTP-POST binding)
 *   GET  /finish?request=        completes a verified SAML sign-in in the browser that started it
 *   GET  /saml/:id/metadata      SP metadata for the identity provider administrator
 *
 * Every success and every failure that can be tied to a provider is written to the audit log of the
 * provider's organization (auth.sso_login / auth.sso_failed).
 */
export const ssoRouter: Router = Router();

const ssoLimiter = rateLimit({
  store: limiterStore('auth:sso'),
  windowMs: 60_000,
  limit: env.NODE_ENV === 'test' ? 10_000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } },
});

const PROVIDER_COLUMNS = `ip.id, ip.organization_id, ip.kind, ip.name, ip.enabled, ip.oidc_issuer, ip.oidc_client_id, ip.oidc_client_secret_enc,
  ip.oidc_scopes, ip.saml_entry_point, ip.saml_idp_entity_id, ip.saml_idp_cert, ip.saml_request_binding, ip.email_attribute,
  ip.name_attribute, ip.role_attribute, ip.role_mapping, ip.allowed_email_domains, ip.jit_provisioning, ip.default_role, ip.trust_idp_mfa`;

const webUrl = (path: string) => `${env.WEB_ORIGIN.replace(/\/+$/, '')}${path}`;

function setBindingCookie(res: Response, value: string): void {
  res.cookie(SSO_BINDING_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: SSO_COOKIE_PATH,
    maxAge: SSO_REQUEST_TTL_MS,
  });
}
const clearBindingCookie = (res: Response) =>
  res.clearCookie(SSO_BINDING_COOKIE, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: SSO_COOKIE_PATH });

async function auditSso(db: Db, p: Pick<ProviderRow, 'id' | 'organization_id' | 'name' | 'kind'>, req: Request, action: 'auth.sso_login' | 'auth.sso_failed', user: { id: string; email: string } | null, metadata: Record<string, unknown>) {
  await db.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
     VALUES ($1,$2,$3,$4,'identity_provider',$5,$6,$7)`,
    [p.organization_id, user?.id ?? null, user?.email ?? null, action, p.id, JSON.stringify({ provider: p.name, kind: p.kind, ...metadata }), req.ip ?? null],
  );
}

/** Ends an attempt with an error: audited when the provider is known, then back to the sign-in page. */
async function fail(req: Request, res: Response, p: ProviderRow | null, err: unknown, email: string | null = null): Promise<void> {
  const e = err instanceof SsoError ? err : new SsoError('sso_failed', 'Single sign-on failed');
  if (!(err instanceof SsoError)) logger.error({ err, provider_id: p?.id }, 'sso: unexpected error');
  logger.warn({ provider_id: p?.id, reason: e.code, ip: req.ip }, 'sso sign-in failed');
  if (p) {
    await auditSso(systemPool, p, req, 'auth.sso_failed', null, { reason: e.code, detail: e.message.slice(0, 200), ...(email ? { email } : {}) }).catch(
      (auditErr: unknown) => logger.error({ err: auditErr }, 'sso: could not write the failure to the audit log'),
    );
  }
  clearBindingCookie(res);
  res.redirect(303, webUrl(`/login?sso_error=${encodeURIComponent(e.code)}`));
}

async function loadProvider(id: string): Promise<ProviderRow | null> {
  const r = await systemPool.query<ProviderRow>(`SELECT ${PROVIDER_COLUMNS} FROM identity_providers ip WHERE ip.id = $1`, [id]);
  return r.rows[0] ?? null;
}

interface RequestRow {
  id: string;
  provider_id: string;
  binding_hash: string;
  nonce: string | null;
  code_verifier_enc: string | null;
  saml_request_id: string | null;
  completed_user_id: string | null;
}

/** An open attempt of a still-enabled provider. */
async function loadRequest(id: string, state: 'open' | 'completed'): Promise<{ r: RequestRow; p: ProviderRow } | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const rows = await systemPool.query<RequestRow>(
    `SELECT id, provider_id, binding_hash, nonce, code_verifier_enc, saml_request_id, completed_user_id
       FROM sso_requests
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
        AND ${state === 'open' ? 'completed_at IS NULL' : 'completed_at IS NOT NULL'}`,
    [id],
  );
  const r = rows.rows[0];
  if (!r) return null;
  const p = await loadProvider(r.provider_id);
  return p ? { r, p } : null;
}

function assertSameBrowser(req: Request, r: RequestRow): void {
  const cookie = readCookie(req, SSO_BINDING_COOKIE);
  if (!cookie || !safeEqual(sha256(cookie), r.binding_hash)) {
    throw new SsoError('sso_browser_mismatch', 'This sign-in was started in another browser or has expired. Start again.');
  }
}

// ── discover ──────────────────────────────────────────────────────────────────────────────────
ssoRouter.get('/discover', ssoLimiter, async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) }), req.query);
  const r = await systemPool.query<{ id: string; name: string; kind: 'oidc' | 'saml' }>(
    `SELECT id, name, kind FROM identity_providers WHERE enabled AND $1 = ANY(allowed_email_domains) ORDER BY name LIMIT 10`,
    [emailDomain(email)],
  );
  const body: SsoDiscoverResponse = { providers: r.rows };
  res.json(body);
});

// ── start ─────────────────────────────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

ssoRouter.get('/:id/start', ssoLimiter, async (req, res) => {
  const { id } = parse(z.object({ id: z.uuid() }), req.params);
  const { login_hint } = parse(z.object({ login_hint: z.string().trim().max(254).optional() }), req.query);
  const p = await loadProvider(id);
  if (!p || !p.enabled) {
    await fail(req, res, null, new SsoError('sso_unknown_provider', 'This sign-in option is not available'));
    return;
  }
  try {
    const binding = randomToken(32);
    const nonce = p.kind === 'oidc' ? newNonce() : null;
    const verifier = p.kind === 'oidc' ? newCodeVerifier() : null;
    const created = await systemPool.query<{ id: string }>(
      `INSERT INTO sso_requests (provider_id, organization_id, binding_hash, nonce, code_verifier_enc, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6)) RETURNING id`,
      [p.id, p.organization_id, sha256(binding), nonce, verifier ? encryptSecret(verifier) : null, SSO_REQUEST_TTL_MS / 1000],
    );
    const requestId = created.rows[0]!.id;
    const urls = serviceProviderUrls(p.id);

    if (p.kind === 'oidc') {
      const url = await authorizationUrl(
        { issuer: p.oidc_issuer!, clientId: p.oidc_client_id!, clientSecret: null, scopes: p.oidc_scopes },
        { state: requestId, nonce: nonce!, codeVerifier: verifier!, redirectUri: urls.oidc_redirect_uri, loginHint: login_hint },
      );
      setBindingCookie(res, binding);
      res.redirect(302, url);
      return;
    }

    let samlRequestId: string | null = null;
    const record = (rid: string) => {
      samlRequestId = rid;
    };
    const saml = p as unknown as SamlProviderRow;
    const recordRequestId = async () => {
      if (!samlRequestId) throw new SsoError('sso_failed', 'The SAML request could not be created');
      await systemPool.query(`UPDATE sso_requests SET saml_request_id = $2 WHERE id = $1`, [requestId, samlRequestId]);
    };
    if (p.saml_request_binding === 'post') {
      const fields = await samlPostFields(saml, requestId, record);
      await recordRequestId();
      setBindingCookie(res, binding);
      const scriptNonce = randomToken(16);
      const target = new URL(p.saml_entry_point!);
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${scriptNonce}'; form-action ${target.origin}; base-uri 'none'; frame-ancestors 'none'`);
      res.setHeader('Cache-Control', 'no-store');
      const inputs = Object.entries(fields)
        .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
        .join('');
      res.type('html').send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Nigafiy sign-in</title></head><body>` +
          `<form method="post" action="${escapeHtml(target.toString())}">${inputs}<noscript><button type="submit">Continue to sign in</button></noscript></form>` +
          `<script nonce="${scriptNonce}">document.forms[0].submit();</script></body></html>`,
      );
      return;
    }
    const url = await samlRedirectUrl(saml, requestId, record);
    await recordRequestId();
    setBindingCookie(res, binding);
    res.redirect(302, url);
  } catch (err) {
    await fail(req, res, p, err);
  }
});

// ── completion ────────────────────────────────────────────────────────────────────────────────
/** Session (or the local MFA step the provider's policy asks for) for a verified, browser-bound sign-in. */
async function finishSignIn(req: Request, res: Response, p: ProviderRow, user: ResolvedSsoUser): Promise<void> {
  const org = await systemPool.query<{ mfa_required: MfaRequirement }>(`SELECT mfa_required FROM organizations WHERE id = $1`, [p.organization_id]);
  const mfaRequired = org.rows[0]?.mfa_required ?? 'off';
  const orgDemandsMfa = mfaRequired === 'all' || (mfaRequired === 'admins' && (user.role === 'owner' || user.role === 'admin'));
  clearBindingCookie(res);

  if (!p.trust_idp_mfa && (user.hasTotp || orgDemandsMfa)) {
    const purpose = user.hasTotp ? 'mfa_login' : 'mfa_enroll';
    const token = randomToken(32);
    await systemPool.query(
      `INSERT INTO auth_tokens (user_id, organization_id, purpose, token_hash, expires_at, sso_provider_id)
       VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5), $6)`,
      [user.userId, p.organization_id, purpose, sha256(token), purpose === 'mfa_login' ? 5 : 10, p.id],
    );
    await auditSso(systemPool, p, req, 'auth.sso_login', { id: user.userId, email: user.email }, { next: purpose, jit_created: user.jitCreated, ...(user.roleChangedFrom ? { role_from: user.roleChangedFrom, role_to: user.role } : {}) });
    // The token travels in the fragment: never sent to a server, never in access logs.
    res.redirect(303, webUrl(`/login#${purpose === 'mfa_login' ? 'sso_mfa' : 'sso_mfa_setup'}=${encodeURIComponent(token)}`));
    return;
  }

  await systemPool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.userId]);
  await createSession(res, req, user.userId, p.organization_id, p.id);
  await auditSso(systemPool, p, req, 'auth.sso_login', { id: user.userId, email: user.email }, {
    jit_created: user.jitCreated,
    mfa: p.trust_idp_mfa ? 'identity_provider' : 'not_required',
    ...(user.roleChangedFrom ? { role_from: user.roleChangedFrom, role_to: user.role } : {}),
  });
  res.redirect(303, webUrl('/'));
}

async function resolveAndMark(p: ProviderRow, requestId: string, claims: SsoClaims, consume: boolean): Promise<ResolvedSsoUser> {
  return withSystem(async (db) => {
    const user = await resolveSsoUser(db, p, claims);
    const marked = await db.query(
      `UPDATE sso_requests SET completed_at = now(), completed_user_id = $2${consume ? ', consumed_at = now()' : ''}
        WHERE id = $1 AND completed_at IS NULL AND consumed_at IS NULL`,
      [requestId, user.userId],
    );
    if (marked.rowCount !== 1) throw new SsoError('sso_request_used', 'This sign-in was already used. Start again.');
    return user;
  });
}

ssoRouter.get('/oidc/callback', ssoLimiter, async (req, res) => {
  const q = parse(
    z.object({ state: z.string().max(100).optional(), code: z.string().max(4096).optional(), error: z.string().max(200).optional() }),
    req.query,
  );
  const found = q.state ? await loadRequest(q.state, 'open') : null;
  if (!found || found.p.kind !== 'oidc') {
    await fail(req, res, found?.p ?? null, new SsoError('sso_request_expired', 'This sign-in has expired or was already used. Start again.'));
    return;
  }
  const { r, p } = found;
  let email: string | null = null;
  try {
    assertSameBrowser(req, r);
    if (!p.enabled) throw new SsoError('sso_unknown_provider', 'This sign-in option is not available');
    if (q.error) throw new SsoError('idp_denied', `The identity provider did not sign you in (${q.error.replace(/[^\w.-]/g, '').slice(0, 60)})`);
    if (!q.code || !r.nonce || !r.code_verifier_enc) throw new SsoError('idp_bad_response', 'The identity provider sent no authorization code');
    const claims = await exchangeCode(
      { issuer: p.oidc_issuer!, clientId: p.oidc_client_id!, clientSecret: p.oidc_client_secret_enc ? decryptSecret(p.oidc_client_secret_enc) : null, scopes: p.oidc_scopes },
      { code: q.code, codeVerifier: decryptSecret(r.code_verifier_enc), redirectUri: serviceProviderUrls(p.id).oidc_redirect_uri, nonce: r.nonce },
    );
    const raw = claims as Record<string, unknown>;
    email = typeof raw[p.email_attribute] === 'string' ? (raw[p.email_attribute] as string) : null;
    const user = await resolveAndMark(p, r.id, {
      subject: String(claims.sub),
      email,
      emailVerified: typeof raw.email_verified === 'boolean' ? raw.email_verified : undefined,
      name: typeof raw[p.name_attribute ?? 'name'] === 'string' ? (raw[p.name_attribute ?? 'name'] as string) : null,
      roleValues: claimValues(raw, p.role_attribute),
    }, true);
    await finishSignIn(req, res, p, user);
  } catch (err) {
    await fail(req, res, p, err, email);
  }
});

ssoRouter.post('/saml/acs', ssoLimiter, express.urlencoded({ extended: false, limit: '512kb' }), async (req, res) => {
  const body = z.object({ SAMLResponse: z.string().min(1).max(500_000), RelayState: z.string().max(100).optional() }).safeParse(req.body);
  const found = body.success && body.data.RelayState ? await loadRequest(body.data.RelayState, 'open') : null;
  if (!body.success || !found || found.p.kind !== 'saml' || !found.r.saml_request_id) {
    await fail(req, res, found?.p ?? null, new SsoError('sso_request_expired', 'This sign-in has expired or was already used. Start again.'));
    return;
  }
  const { r, p } = found;
  let email: string | null = null;
  try {
    if (!p.enabled) throw new SsoError('sso_unknown_provider', 'This sign-in option is not available');
    const profile = await validateSamlResponse(p as unknown as SamlProviderRow, r.saml_request_id!, { SAMLResponse: body.data.SAMLResponse, RelayState: r.id });
    const attrs = profile as unknown as Record<string, unknown>;
    const pick = (name: string | null): string | null => {
      const v = name ? claimValues(attrs, name)[0] : undefined;
      return v ?? null;
    };
    email =
      pick(p.email_attribute) ??
      pick('email') ??
      pick('mail') ??
      (profile.nameIDFormat === 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' ? profile.nameID : null);
    // The POST came from the identity provider's page, without our browser-binding cookie
    // (SameSite=Lax). The sign-in completes only when the same browser follows the redirect.
    await resolveAndMark(p, r.id, { subject: profile.nameID, email, name: pick(p.name_attribute), roleValues: claimValues(attrs, p.role_attribute) }, false);
    res.redirect(303, webUrl(`/api/v1/auth/sso/finish?request=${r.id}`));
  } catch (err) {
    await fail(req, res, p, err, email);
  }
});

ssoRouter.get('/finish', ssoLimiter, async (req, res) => {
  const { request } = parse(z.object({ request: z.string().max(100) }), req.query);
  const found = await loadRequest(request, 'completed');
  if (!found || !found.r.completed_user_id) {
    await fail(req, res, found?.p ?? null, new SsoError('sso_request_expired', 'This sign-in has expired or was already used. Start again.'));
    return;
  }
  const { r, p } = found;
  try {
    assertSameBrowser(req, r);
    if (!p.enabled) throw new SsoError('sso_unknown_provider', 'This sign-in option is not available');
    const consumed = await systemPool.query(`UPDATE sso_requests SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`, [r.id]);
    if (consumed.rowCount !== 1) throw new SsoError('sso_request_used', 'This sign-in was already used. Start again.');
    // Re-check the membership: it may have changed since the assertion was verified.
    const user = await systemPool.query<{ email: string; role: ResolvedSsoUser['role']; status: string; has_totp: boolean }>(
      `SELECT u.email, m.role, m.status, (u.mfa_secret_enc IS NOT NULL) AS has_totp
         FROM users u JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2 WHERE u.id = $1`,
      [r.completed_user_id, p.organization_id],
    );
    const u = user.rows[0];
    if (!u || u.status !== 'active') throw new SsoError('account_deactivated', 'Your account has been deactivated in this organization');
    await finishSignIn(req, res, p, { userId: r.completed_user_id!, email: u.email, role: u.role, jitCreated: false, roleChangedFrom: null, hasTotp: u.has_totp });
  } catch (err) {
    await fail(req, res, p, err);
  }
});

ssoRouter.get('/saml/:id/metadata', async (req, res) => {
  const { id } = parse(z.object({ id: z.uuid() }), req.params);
  const r = await systemPool.query(`SELECT 1 FROM identity_providers WHERE id = $1 AND kind = 'saml'`, [id]);
  if (!r.rowCount) throw new AppError(404, 'not_found', 'Identity provider not found');
  res.type('application/samlmetadata+xml').send(spMetadata(id));
});

/** Housekeeping: expired attempts and expired SAML cache entries. */
export async function cleanupSso(): Promise<void> {
  await systemPool.query(`DELETE FROM sso_requests WHERE expires_at < now() - interval '1 day'`);
  await systemPool.query(`DELETE FROM saml_cache WHERE expires_at < now()`);
}
