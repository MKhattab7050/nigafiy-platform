import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemPool } from '../src/infrastructure/db.ts';
import { resetOidcCaches } from '../src/modules/auth/sso/oidc.ts';
import { CSRF, app, newAccount, setRole, type TestAccount } from './helpers.ts';
import { OidcIdp, assertionXml, authnRequestId, b64, responseXml, samlKeys, signAssertion } from './sso-idp.ts';

const WEB = 'http://localhost:3100';
const idp = new OidcIdp();

beforeAll(async () => {
  resetOidcCaches();
  await idp.start();
});
afterAll(async () => {
  await idp.stop();
});

const uniqueDomain = () => `corp-${randomUUID().slice(0, 8)}.test`;

async function createOidc(owner: TestAccount, extra: Record<string, unknown> = {}) {
  const domain = uniqueDomain();
  const res = await owner.agent
    .post('/api/v1/sso/providers')
    .set(CSRF)
    .send({
      kind: 'oidc',
      name: 'Test OIDC',
      oidc_issuer: idp.issuer,
      oidc_client_id: idp.clientId,
      oidc_client_secret: idp.clientSecret,
      allowed_email_domains: [domain],
      role_attribute: 'groups',
      role_mapping: [
        { value: 'net-admins', role: 'admin' },
        { value: 'helpdesk', role: 'technician' },
      ],
      jit_provisioning: true,
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.id as string, domain, body: res.body };
}

async function oidcSignIn(agent: ReturnType<typeof request.agent>, providerId: string, claims: Record<string, unknown>, tamper?: Parameters<OidcIdp['issueCode']>[2]) {
  const start = await agent.get(`/api/v1/auth/sso/${providerId}/start`);
  expect(start.status).toBe(302);
  expect(start.headers.location!).toMatch(new RegExp(`^${idp.issuer}/authorize\\?`));
  const { code, state } = idp.issueCode(start.headers.location!, claims, tamper);
  return { res: await agent.get('/api/v1/auth/sso/oidc/callback').query({ state, code }), state, code };
}

const auditActions = async (orgId: string) =>
  (await systemPool.query<{ action: string; metadata: Record<string, unknown> }>(`SELECT action, metadata FROM audit_logs WHERE organization_id = $1 ORDER BY created_at`, [orgId])).rows;

describe('SSO administration', () => {
  it('is owner/admin only, keeps the client secret write-only and sealed, and audits every change', async () => {
    const owner = await newAccount('sso-admin');
    const { id, body } = await createOidc(owner);
    expect(body).not.toHaveProperty('oidc_client_secret');
    expect(body.oidc_client_secret_set).toBe(true);
    expect(body.service_provider.oidc_redirect_uri).toBe(`${WEB}/api/v1/auth/sso/oidc/callback`);
    expect(JSON.stringify(body)).not.toContain(idp.clientSecret);
    const stored = await systemPool.query<{ oidc_client_secret_enc: string }>(`SELECT oidc_client_secret_enc FROM identity_providers WHERE id = $1`, [id]);
    expect(stored.rows[0]!.oidc_client_secret_enc).toMatch(/^v1:/);
    expect(stored.rows[0]!.oidc_client_secret_enc).not.toContain(idp.clientSecret);

    const list = await owner.agent.get('/api/v1/sso/providers');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(idp.clientSecret);

    const patch = await owner.agent.patch(`/api/v1/sso/providers/${id}`).set(CSRF).send({ name: 'Renamed', trust_idp_mfa: false });
    expect(patch.status).toBe(200);
    expect(patch.body.name).toBe('Renamed');
    expect(patch.body.trust_idp_mfa).toBe(false);
    expect(patch.body.oidc_client_secret_set).toBe(true); // untouched
    const wrong = await owner.agent.patch(`/api/v1/sso/providers/${id}`).set(CSRF).send({ saml_entry_point: 'https://idp.example.com/sso' });
    expect(wrong.status).toBe(400);

    const check = await owner.agent.post(`/api/v1/sso/providers/${id}/check`).set(CSRF).send({});
    expect(check.status).toBe(200);
    expect(check.body.ok).toBe(true);

    // Plain http is refused for a non-loopback issuer; bad domains and certificates are refused.
    const bad = await owner.agent.post('/api/v1/sso/providers').set(CSRF).send({ kind: 'oidc', name: 'x', oidc_issuer: 'http://idp.example.com', oidc_client_id: 'c', allowed_email_domains: ['example.com'] });
    expect(bad.status).toBe(400);
    const badDomain = await owner.agent.post('/api/v1/sso/providers').set(CSRF).send({ kind: 'oidc', name: 'x', oidc_issuer: idp.issuer, oidc_client_id: 'c', allowed_email_domains: ['not a domain'] });
    expect(badDomain.status).toBe(400);
    const badCert = await owner.agent.post('/api/v1/sso/providers').set(CSRF).send({ kind: 'saml', name: 'x', saml_entry_point: 'https://idp.example.com/sso', saml_idp_entity_id: 'urn:x', saml_idp_cert: 'not a cert', allowed_email_domains: ['example.com'] });
    expect(badCert.status).toBe(400);
    const ownerRole = await owner.agent.post('/api/v1/sso/providers').set(CSRF).send({ kind: 'oidc', name: 'x', oidc_issuer: idp.issuer, oidc_client_id: 'c', allowed_email_domains: ['example.com'], default_role: 'owner' });
    expect(ownerRole.status).toBe(400);

    await setRole(owner.email, owner.organizationId, 'technician');
    expect((await owner.agent.get('/api/v1/sso/providers')).status).toBe(403);
    expect((await owner.agent.delete(`/api/v1/sso/providers/${id}`).set(CSRF)).status).toBe(403);
    await setRole(owner.email, owner.organizationId, 'admin');
    expect((await owner.agent.delete(`/api/v1/sso/providers/${id}`).set(CSRF)).status).toBe(204);

    const actions = (await auditActions(owner.organizationId)).map((a) => a.action);
    for (const a of ['sso.provider_created', 'sso.provider_updated', 'sso.provider_checked', 'sso.provider_deleted']) expect(actions).toContain(a);
    const updated = (await auditActions(owner.organizationId)).find((a) => a.action === 'sso.provider_updated');
    expect(JSON.stringify(updated)).not.toContain(idp.clientSecret);
  });

  it('another organization cannot see or change the provider', async () => {
    const owner = await newAccount('sso-iso');
    const { id } = await createOidc(owner);
    const other = await newAccount('sso-iso2');
    expect((await other.agent.get('/api/v1/sso/providers')).body.items).toEqual([]);
    expect((await other.agent.patch(`/api/v1/sso/providers/${id}`).set(CSRF).send({ name: 'mine' })).status).toBe(404);
    expect((await other.agent.delete(`/api/v1/sso/providers/${id}`).set(CSRF)).status).toBe(404);
  });
});

describe('OIDC sign-in', () => {
  it('JIT-provisions with the mapped role, pins the session to the organization, and audits', async () => {
    const owner = await newAccount('oidc-jit');
    const { id, domain } = await createOidc(owner);
    const disc = await request(app).get('/api/v1/auth/sso/discover').query({ email: `someone@${domain.toUpperCase()}` });
    expect(disc.body.providers.map((p: { id: string }) => p.id)).toEqual([id]);
    expect((await request(app).get('/api/v1/auth/options')).body.sso_available).toBe(true);

    const browser = request.agent(app);
    const email = `jit-user@${domain}`;
    const { res } = await oidcSignIn(browser, id, { sub: 'sub-jit-1', email, email_verified: true, name: 'Jit User', groups: ['helpdesk', 'staff'] });
    expect(res.status).toBe(303);
    expect(res.headers.location!).toBe(`${WEB}/`);
    // PKCE + client_secret_basic reached the token endpoint.
    const tokenReq = idp.tokenRequests.at(-1)!;
    expect(tokenReq.body.get('code_verifier')).toBeTruthy();
    expect(tokenReq.authorization).toMatch(/^Basic /);

    const me = await browser.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.role).toBe('technician');
    expect(me.body.organization.id).toBe(owner.organizationId);

    // Another organization the same user is a member of is not reachable from this session.
    const elsewhere = await newAccount('oidc-other-org');
    const userId = me.body.user.id as string;
    await systemPool.query(`INSERT INTO memberships (user_id, organization_id, role, status) VALUES ($1,$2,'viewer','active')`, [userId, elsewhere.organizationId]);
    expect((await browser.get('/api/v1/auth/me')).body.memberships).toHaveLength(1);
    const sw = await browser.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: elsewhere.organizationId });
    expect(sw.status).toBe(403);
    expect(sw.body.error.code).toBe('sso_session_pinned');

    const audits = await auditActions(owner.organizationId);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['sso.user_provisioned', 'auth.sso_login']));

    // Second sign-in: same subject → same user; the mapping now says admin → role synced and audited.
    const again = request.agent(app);
    const second = await oidcSignIn(again, id, { sub: 'sub-jit-1', email, email_verified: true, groups: ['net-admins'] });
    expect(second.res.headers.location!).toBe(`${WEB}/`);
    expect((await again.get('/api/v1/auth/me')).body.role).toBe('admin');
    expect((await auditActions(owner.organizationId)).some((a) => a.action === 'sso.role_synced')).toBe(true);

    // Disabling the provider ends its sessions.
    await owner.agent.patch(`/api/v1/sso/providers/${id}`).set(CSRF).send({ enabled: false });
    expect((await again.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects tampered, foreign or replayed tokens and records each failure', async () => {
    const owner = await newAccount('oidc-neg');
    const { id, domain } = await createOidc(owner);
    const claims = { sub: 'neg-1', email: `neg@${domain}`, email_verified: true };
    const cases: Array<[Parameters<OidcIdp['issueCode']>[2], string]> = [
      [{ nonce: 'not-the-nonce' }, 'invalid_id_token'],
      [{ aud: 'someone-else' }, 'invalid_id_token'],
      [{ iss: 'https://evil.example' }, 'invalid_id_token'],
      [{ expSecondsFromNow: -600 }, 'invalid_id_token'],
      [{ hs256: true }, 'invalid_id_token'],
      [{ otherKey: true }, 'invalid_id_token'],
    ];
    for (const [tamper, code] of cases) {
      const { res } = await oidcSignIn(request.agent(app), id, claims, tamper);
      expect(res.headers.location!, JSON.stringify(tamper)).toBe(`${WEB}/login?sso_error=${code}`);
    }
    // Unverified email, foreign domain.
    expect((await oidcSignIn(request.agent(app), id, { ...claims, email_verified: false })).res.headers.location!).toContain('sso_error=sso_email_unverified');
    expect((await oidcSignIn(request.agent(app), id, { ...claims, email: 'x@other-domain.test' })).res.headers.location!).toContain('sso_error=sso_domain_not_allowed');

    // The callback in a different browser than the one that started the sign-in.
    const a = request.agent(app);
    const start = await a.get(`/api/v1/auth/sso/${id}/start`);
    const issued = idp.issueCode(start.headers.location!, claims);
    const stolen = await request(app).get('/api/v1/auth/sso/oidc/callback').query(issued);
    expect(stolen.headers.location!).toContain('sso_error=sso_browser_mismatch');

    // A state is single use.
    const b = request.agent(app);
    const ok = await oidcSignIn(b, id, claims);
    expect(ok.res.headers.location!).toBe(`${WEB}/`);
    const replay = await b.get('/api/v1/auth/sso/oidc/callback').query({ state: ok.state, code: ok.code });
    expect(replay.headers.location!).toContain('sso_error=sso_request_expired');

    const failures = (await auditActions(owner.organizationId)).filter((x) => x.action === 'auth.sso_failed');
    expect(failures.length).toBeGreaterThanOrEqual(cases.length + 3);
    expect(failures.map((f) => f.metadata.reason)).toEqual(expect.arrayContaining(['invalid_id_token', 'sso_email_unverified', 'sso_domain_not_allowed', 'sso_browser_mismatch']));
  });

  it('without JIT only members sign in; an existing account is never attached by JIT', async () => {
    const owner = await newAccount('oidc-members');
    const ownerDomain = owner.email.split('@')[1]!;
    const { id } = await createOidc(owner, { jit_provisioning: false, allowed_email_domains: [ownerDomain] });
    // The owner (a member) links by email; owners are never re-mapped.
    const ok = await oidcSignIn(request.agent(app), id, { sub: 'owner-sub', email: owner.email, email_verified: true, groups: ['helpdesk'] });
    expect(ok.res.headers.location!).toBe(`${WEB}/`);
    expect((await systemPool.query(`SELECT role FROM memberships WHERE organization_id = $1 AND role = 'owner'`, [owner.organizationId])).rowCount).toBe(1);
    const stranger = await oidcSignIn(request.agent(app), id, { sub: 's', email: `stranger-${randomUUID().slice(0, 6)}@${ownerDomain}`, email_verified: true });
    expect(stranger.res.headers.location!).toContain('sso_error=sso_not_member');

    // JIT on, but the address belongs to an existing account of another organization.
    const outsider = await newAccount('oidc-outsider');
    await owner.agent.patch(`/api/v1/sso/providers/${id}`).set(CSRF).send({ jit_provisioning: true });
    const attach = await oidcSignIn(request.agent(app), id, { sub: 'o', email: outsider.email, email_verified: true });
    expect(attach.res.headers.location!).toContain('sso_error=sso_account_exists');
    expect((await systemPool.query(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.organization_id = $2`, [outsider.email, owner.organizationId])).rowCount).toBe(0);

    // A deactivated member is refused.
    await systemPool.query(`UPDATE memberships SET status = 'deactivated' WHERE organization_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)`, [owner.organizationId, owner.email]);
    const deact = await oidcSignIn(request.agent(app), id, { sub: 'owner-sub', email: owner.email, email_verified: true });
    expect(deact.res.headers.location!).toContain('sso_error=account_deactivated');
  });

  it('with trust_idp_mfa off, the organization MFA policy still applies after SSO', async () => {
    const owner = await newAccount('oidc-mfa');
    const { id, domain } = await createOidc(owner, { trust_idp_mfa: false, default_role: 'admin' });
    await systemPool.query(`UPDATE organizations SET mfa_required = 'all' WHERE id = $1`, [owner.organizationId]);
    const browser = request.agent(app);
    const { res } = await oidcSignIn(browser, id, { sub: 'mfa-1', email: `mfa@${domain}`, email_verified: true });
    expect(res.headers.location!).toMatch(new RegExp(`^${WEB}/login#sso_mfa_setup=[\\w-]+$`));
    expect((await browser.get('/api/v1/auth/me')).status).toBe(401); // no session before MFA
    const token = decodeURIComponent(res.headers.location!.split('=')[1]!);
    const row = await systemPool.query<{ purpose: string; sso_provider_id: string }>(`SELECT purpose, sso_provider_id FROM auth_tokens WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [token]);
    expect(row.rows[0]).toEqual({ purpose: 'mfa_enroll', sso_provider_id: id });

    // Default (trust_idp_mfa on): the identity provider handles MFA, the session starts directly.
    await owner.agent.patch(`/api/v1/sso/providers/${id}`).set(CSRF).send({ trust_idp_mfa: true });
    const direct = await oidcSignIn(request.agent(app), id, { sub: 'mfa-1', email: `mfa@${domain}`, email_verified: true });
    expect(direct.res.headers.location!).toBe(`${WEB}/`);
  });
});

describe('SAML sign-in', () => {
  const keys = samlKeys();
  const otherKeys = samlKeys('attacker');
  const IDP_ENTITY = 'https://idp.test/saml';

  async function createSaml(owner: TestAccount) {
    const domain = uniqueDomain();
    const res = await owner.agent
      .post('/api/v1/sso/providers')
      .set(CSRF)
      .send({
        kind: 'saml',
        name: 'Test SAML',
        saml_entry_point: 'https://idp.test/sso',
        saml_idp_entity_id: IDP_ENTITY,
        saml_idp_cert: keys.certPem,
        allowed_email_domains: [domain],
        role_attribute: 'role',
        role_mapping: [{ value: 'admins', role: 'admin' }],
        jit_provisioning: true,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as string, domain, sp: res.body.service_provider as { saml_acs_url: string; saml_entity_id: string } };
  }

  async function begin(agent: ReturnType<typeof request.agent>, providerId: string) {
    const start = await agent.get(`/api/v1/auth/sso/${providerId}/start`);
    expect(start.status).toBe(302);
    expect(start.headers.location!).toMatch(/^https:\/\/idp\.test\/sso\?SAMLRequest=/);
    const relay = new URL(start.headers.location!).searchParams.get('RelayState')!;
    return { requestId: authnRequestId(start.headers.location!), relay };
  }

  const post = (agent: ReturnType<typeof request.agent>, xml: string, relay: string) =>
    agent.post('/api/v1/auth/sso/saml/acs').type('form').send({ SAMLResponse: b64(xml), RelayState: relay });

  it('signs in with a signed assertion through the browser-bound finish step', async () => {
    const owner = await newAccount('saml-ok');
    const { id, domain, sp } = await createSaml(owner);
    const metadata = await request(app).get(`/api/v1/auth/sso/saml/${id}/metadata`);
    expect(metadata.status).toBe(200);
    expect(metadata.text).toContain(sp.saml_acs_url);

    const browser = request.agent(app);
    const { requestId, relay } = await begin(browser, id);
    const email = `saml-user@${domain}`;
    const assertion = signAssertion(
      assertionXml({ idpEntityId: IDP_ENTITY, audience: sp.saml_entity_id, recipient: sp.saml_acs_url, inResponseTo: requestId, nameId: 'saml-subject-1', attributes: { email, role: ['admins'] } }),
      keys,
    );
    const xml = responseXml({ idpEntityId: IDP_ENTITY, destination: sp.saml_acs_url, inResponseTo: requestId, assertion });
    // The IdP's POST arrives without the browser's cookie (SameSite=Lax): no session yet.
    const acs = await request(app).post('/api/v1/auth/sso/saml/acs').type('form').send({ SAMLResponse: b64(xml), RelayState: relay });
    expect(acs.status).toBe(303);
    expect(acs.headers.location!).toBe(`${WEB}/api/v1/auth/sso/finish?request=${relay}`);
    expect(String(acs.headers['set-cookie'] ?? '')).not.toContain('ld_session');
    // Another browser cannot finish it.
    const thief = await request(app).get(`/api/v1/auth/sso/finish?request=${relay}`);
    expect(thief.headers.location!).toContain('sso_error=sso_browser_mismatch');
    // The browser that started it can.
    const fin = await browser.get(`/api/v1/auth/sso/finish?request=${relay}`);
    expect(fin.headers.location!).toBe(`${WEB}/`);
    const me = await browser.get('/api/v1/auth/me');
    expect(me.body.user.email).toBe(email);
    expect(me.body.role).toBe('admin');
    // Replaying the same response is refused.
    const replay = await post(request.agent(app), xml, relay);
    expect(replay.headers.location!).toContain('sso_error=sso_request_expired');
    expect((await auditActions(owner.organizationId)).map((a) => a.action)).toEqual(expect.arrayContaining(['sso.user_provisioned', 'auth.sso_login']));
    // HTTP-POST binding for the AuthnRequest: an auto-submitting form, locked down by its own CSP.
    await owner.agent.patch(`/api/v1/sso/providers/${id}`).set(CSRF).send({ saml_request_binding: 'post' });
    const form = await request.agent(app).get(`/api/v1/auth/sso/${id}/start`);
    expect(form.status).toBe(200);
    expect(form.text).toContain('action="https://idp.test/sso"');
    expect(form.text).toMatch(/name="SAMLRequest" value="[A-Za-z0-9+/=]+"/);
    expect(form.headers['content-security-policy']).toMatch(/script-src 'nonce-[\w-]+'; form-action https:\/\/idp\.test/);
  });

  it('rejects unsigned, foreign-signed, wrapped, mis-addressed and stale assertions', async () => {
    const owner = await newAccount('saml-neg');
    const { id, domain, sp } = await createSaml(owner);
    const email = `victim@${domain}`;
    type Mut = (p: { requestId: string }) => string;
    const base = (requestId: string, over: Partial<Parameters<typeof assertionXml>[0]> = {}) =>
      assertionXml({ idpEntityId: IDP_ENTITY, audience: sp.saml_entity_id, recipient: sp.saml_acs_url, inResponseTo: requestId, nameId: 'n1', attributes: { email }, ...over });
    const wrap = (requestId: string, assertion: string) => responseXml({ idpEntityId: IDP_ENTITY, destination: sp.saml_acs_url, inResponseTo: requestId, assertion });
    const cases: Array<[string, Mut, string]> = [
      ['unsigned', ({ requestId }) => wrap(requestId, base(requestId)), 'saml_invalid'],
      ['signed by another key', ({ requestId }) => wrap(requestId, signAssertion(base(requestId), otherKeys)), 'saml_invalid'],
      ['wrong audience', ({ requestId }) => wrap(requestId, signAssertion(base(requestId, { audience: 'https://other-sp' }), keys)), 'saml_invalid'],
      ['wrong issuer', ({ requestId }) => wrap(requestId, signAssertion(base(requestId, { idpEntityId: 'https://evil-idp' }), keys)), 'saml_invalid'],
      ['expired', ({ requestId }) => wrap(requestId, signAssertion(base(requestId, { notOnOrAfterSeconds: -600 }), keys)), 'saml_invalid'],
      ['other request', ({ requestId }) => wrap('_not-this-request', signAssertion(base('_not-this-request'), keys)) + requestId.slice(0, 0), 'saml_invalid'],
      ['wrong recipient', ({ requestId }) => wrap(requestId, signAssertion(base(requestId, { recipient: 'https://attacker.example/acs' }), keys)), 'saml_wrong_recipient'],
      [
        // Signature wrapping: a genuinely signed assertion for another subject is kept, and an unsigned
        // assertion for the victim is placed first. Only the signed element may be trusted.
        'signature wrapping',
        ({ requestId }) => {
          const signed = signAssertion(base(requestId, { nameId: 'attacker', attributes: { email: `attacker@${domain}` } }), keys);
          const evil = base(requestId, { nameId: 'victim' });
          return wrap(requestId, evil + signed);
        },
        'saml_invalid',
      ],
      [
        // Content changed after signing (the victim's address swapped in): the digest no longer matches.
        'tampered after signing',
        ({ requestId }) => {
          const signed = signAssertion(base(requestId, { nameId: 'attacker', attributes: { email: `attacker@${domain}` } }), keys);
          return wrap(requestId, signed.replace(`attacker@${domain}`, email));
        },
        'saml_invalid',
      ],
      [
        // Wrapping variant: the signed assertion is hidden inside an Extensions element and an unsigned
        // assertion for the victim is the Response's real child.
        'signed assertion hidden in Extensions',
        ({ requestId }) => {
          const signed = signAssertion(base(requestId, { nameId: 'attacker', attributes: { email: `attacker@${domain}` } }), keys);
          const evil = base(requestId, { nameId: 'victim' });
          return wrap(requestId, `<samlp:Extensions>${signed}</samlp:Extensions>${evil}`);
        },
        'saml_invalid',
      ],
      [
        // Wrapping variant: the unsigned victim assertion is nested inside the signed one, so the
        // signature still verifies over its own element while a naive reader finds the inner one.
        'unsigned assertion nested in a signed one',
        ({ requestId }) => {
          const evil = base(requestId, { nameId: 'victim' });
          const signed = signAssertion(base(requestId, { nameId: 'attacker', attributes: { email: `attacker@${domain}` } }), keys);
          return wrap(requestId, signed.replace('</saml:Assertion>', `${evil}</saml:Assertion>`));
        },
        'saml_invalid',
      ],
    ];
    for (const [label, make, code] of cases) {
      const browser = request.agent(app);
      const { requestId, relay } = await begin(browser, id);
      const res = await post(browser, make({ requestId }), relay);
      expect(res.headers.location!, label).toBe(`${WEB}/login?sso_error=${code}`);
    }
    expect((await systemPool.query(`SELECT 1 FROM users WHERE email = $1`, [email])).rowCount).toBe(0);
    const failures = (await auditActions(owner.organizationId)).filter((a) => a.action === 'auth.sso_failed');
    expect(failures.length).toBeGreaterThanOrEqual(cases.length);
  });
});
