/**
 * Test doubles of identity providers — used ONLY by tests/sso.test.ts. Keys are generated here,
 * tokens and assertions are signed here; nothing reaches a network beyond 127.0.0.1.
 */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { SignJWT, exportJWK, type JWK } from 'jose';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';

// ── OIDC ─────────────────────────────────────────────────────────────────────────────────────
export interface PendingCode {
  nonce: string;
  challenge: string;
  claims: Record<string, unknown>;
  /** Overrides for the ID token: wrong audience, issuer, nonce, expiry, algorithm… */
  tamper?: { aud?: string; iss?: string; nonce?: string; expSecondsFromNow?: number; hs256?: boolean; otherKey?: boolean };
}

export class OidcIdp {
  server!: http.Server;
  issuer = '';
  readonly clientId = 'nigafiy-test-client';
  readonly clientSecret = 'test-client-secret-value';
  private readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private jwk!: JWK;
  readonly codes = new Map<string, PendingCode>();
  tokenRequests: Array<{ authorization: string | undefined; body: URLSearchParams }> = [];

  async start(): Promise<void> {
    this.jwk = { ...(await exportJWK(this.key.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  /** What the authorization endpoint would do after the user signs in: issue a code. */
  issueCode(authorizeUrl: string, claims: Record<string, unknown>, tamper?: PendingCode['tamper']): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 missing');
    const code = randomUUID();
    this.codes.set(code, { nonce: u.searchParams.get('nonce')!, challenge: u.searchParams.get('code_challenge')!, claims, tamper });
    return { code, state: u.searchParams.get('state')! };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
      return;
    }
    if (url.pathname === '/jwks') return json(200, { keys: [this.jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = new URLSearchParams(raw);
      this.tokenRequests.push({ authorization: req.headers.authorization, body });
      const expected = `Basic ${Buffer.from(`${this.clientId}:${encodeURIComponent(this.clientSecret)}`).toString('base64')}`;
      if (req.headers.authorization !== expected) return json(401, { error: 'invalid_client' });
      const pending = this.codes.get(body.get('code') ?? '');
      if (!pending) return json(400, { error: 'invalid_grant' });
      this.codes.delete(body.get('code')!);
      const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== pending.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token: await this.idToken(pending) });
    }
    res.writeHead(404).end();
  }

  private async idToken(p: PendingCode): Promise<string> {
    const t = p.tamper ?? {};
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({ ...p.claims, nonce: t.nonce ?? p.nonce })
      .setIssuer(t.iss ?? this.issuer)
      .setAudience(t.aud ?? this.clientId)
      .setIssuedAt(now - 5)
      .setExpirationTime(now + (t.expSecondsFromNow ?? 300));
    if (t.hs256) return jwt.setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(this.clientSecret));
    return jwt.setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(t.otherKey ? this.otherKey.privateKey : this.key.privateKey);
  }
}

// ── SAML ─────────────────────────────────────────────────────────────────────────────────────
export interface SamlKeys {
  privateKeyPem: string;
  certPem: string;
}

export function samlKeys(commonName = 'test-idp'): SamlKeys {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privateKeyPem), forge.md.sha256.create());
  return { privateKeyPem, certPem: forge.pki.certificateToPem(cert) };
}

/** The AuthnRequest ID inside a HTTP-Redirect binding URL. */
export function authnRequestId(redirectUrl: string): string {
  const req = new URL(redirectUrl).searchParams.get('SAMLRequest')!;
  const xml = inflateRawSync(Buffer.from(req, 'base64')).toString('utf8');
  return /\sID="([^"]+)"/.exec(xml)![1]!;
}

export interface AssertionInput {
  idpEntityId: string;
  audience: string;
  recipient: string;
  inResponseTo: string;
  nameId: string;
  attributes: Record<string, string | string[]>;
  notOnOrAfterSeconds?: number;
  assertionId?: string;
}

const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function assertionXml(a: AssertionInput): string {
  const until = iso(a.notOnOrAfterSeconds ?? 300);
  const attrs = Object.entries(a.attributes)
    .map(
      ([name, v]) =>
        `<saml:Attribute Name="${esc(name)}">${(Array.isArray(v) ? v : [v]).map((x) => `<saml:AttributeValue>${esc(x)}</saml:AttributeValue>`).join('')}</saml:Attribute>`,
    )
    .join('');
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${a.assertionId ?? `_a${randomUUID().replace(/-/g, '')}`}" Version="2.0" IssueInstant="${iso(-5)}">` +
    `<saml:Issuer>${esc(a.idpEntityId)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${esc(a.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${until}" Recipient="${esc(a.recipient)}" InResponseTo="${esc(a.inResponseTo)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(-30)}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${esc(a.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(-5)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` +
    `</saml:Assertion>`
  );
}

export function signAssertion(assertion: string, keys: SamlKeys): string {
  const sig = new SignedXml({
    privateKey: keys.privateKeyPem,
    publicCert: keys.certPem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
  return sig.getSignedXml();
}

export function responseXml(p: { idpEntityId: string; destination: string; inResponseTo: string; assertion: string }): string {
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID().replace(/-/g, '')}" Version="2.0" IssueInstant="${iso(-2)}" Destination="${esc(p.destination)}" InResponseTo="${esc(p.inResponseTo)}">` +
    `<saml:Issuer>${esc(p.idpEntityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    p.assertion +
    `</samlp:Response>`
  );
}

export const b64 = (xml: string) => Buffer.from(xml, 'utf8').toString('base64');
