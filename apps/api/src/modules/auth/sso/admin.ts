import { X509Certificate } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { IdentityProvider } from '@nigafiy/shared-types';
import { audit } from '../../../common/audit.ts';
import { encryptSecret } from '../../../common/crypto.ts';
import { AppError, auth, idParams, notFound, parse, requireRole } from '../../../common/http.ts';
import { systemPool, withTenant } from '../../../infrastructure/db.ts';
import { SsoError, idpUrlProblem, normalizeDomain, serviceProviderUrls } from './config.ts';
import { discover } from './oidc.ts';

/**
 * Organization identity providers (Settings → Single sign-on). Owner and admin only: reading the
 * configuration included, since it shows which domains and roles the organization trusts.
 * The OIDC client secret is write-only (sealed at rest, never returned, never logged).
 */
export const ssoAdminRouter: Router = Router();

const idpUrl = z
  .string()
  .trim()
  .max(500)
  .superRefine((v, ctx) => {
    const problem = idpUrlProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: `URL ${problem}` });
  });

const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const domainList = z
  .array(z.string().transform(normalizeDomain).pipe(z.string().regex(DOMAIN, 'Not a domain name')))
  .min(1, 'Add at least one email domain')
  .max(20)
  .transform((list) => [...new Set(list)]);

const attribute = z.string().trim().min(1).max(200);
const assignable = z.enum(['viewer', 'technician', 'admin']);

/** PEM or bare base64 DER → normalized PEM, refused unless it parses as an X.509 certificate. */
export function normalizeCertificate(input: string): string {
  const body = input
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) throw new Error('not base64');
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(pem); // throws when it is not a certificate
  return pem;
}
const certificate = z
  .string()
  .max(20000)
  .transform((v, ctx) => {
    try {
      return normalizeCertificate(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Paste the identity provider’s signing certificate (PEM)' });
      return z.NEVER;
    }
  });

const roleMapping = z.array(z.object({ value: z.string().min(1).max(200), role: assignable }).strict()).max(50);
const scopes = z
  .string()
  .trim()
  .max(300)
  .regex(/^[\x21-\x7e]+( [\x21-\x7e]+)*$/, 'Space-separated scopes');
const binding = z.enum(['redirect', 'post']);

const common = {
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  email_attribute: attribute.default('email'),
  name_attribute: attribute.nullable().default(null),
  role_attribute: attribute.nullable().default(null),
  role_mapping: roleMapping.default([]),
  allowed_email_domains: domainList,
  jit_provisioning: z.boolean().default(false),
  default_role: assignable.default('viewer'),
  trust_idp_mfa: z.boolean().default(true),
};
const oidcFields = {
  oidc_issuer: idpUrl,
  oidc_client_id: z.string().trim().min(1).max(300),
  oidc_client_secret: z.string().min(1).max(2000).optional(),
  oidc_scopes: scopes.default('openid email profile'),
};
const samlFields = {
  saml_entry_point: idpUrl,
  saml_idp_entity_id: z.string().trim().min(1).max(500),
  saml_idp_cert: certificate,
  saml_request_binding: binding.default('redirect'),
};

const createSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('oidc'), ...common, ...oidcFields }).strict(),
  z.object({ kind: z.literal('saml'), ...common, ...samlFields }).strict(),
]);

// Updates: every field optional and WITHOUT defaults (an absent field is left as it is).
const updateSchema = z
  .object({
    name: common.name.optional(),
    enabled: z.boolean().optional(),
    email_attribute: attribute.optional(),
    name_attribute: attribute.nullable().optional(),
    role_attribute: attribute.nullable().optional(),
    role_mapping: roleMapping.optional(),
    allowed_email_domains: domainList.optional(),
    jit_provisioning: z.boolean().optional(),
    default_role: assignable.optional(),
    trust_idp_mfa: z.boolean().optional(),
    oidc_issuer: idpUrl.optional(),
    oidc_client_id: oidcFields.oidc_client_id.optional(),
    oidc_client_secret: oidcFields.oidc_client_secret,
    clear_oidc_client_secret: z.boolean().optional(),
    oidc_scopes: scopes.optional(),
    saml_entry_point: idpUrl.optional(),
    saml_idp_entity_id: samlFields.saml_idp_entity_id.optional(),
    saml_idp_cert: certificate.optional(),
    saml_request_binding: binding.optional(),
  })
  .strict();

interface Row {
  id: string;
  kind: 'oidc' | 'saml';
  name: string;
  enabled: boolean;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_set: boolean;
  oidc_scopes: string;
  saml_entry_point: string | null;
  saml_idp_entity_id: string | null;
  saml_idp_cert: string | null;
  saml_request_binding: 'redirect' | 'post';
  email_attribute: string;
  name_attribute: string | null;
  role_attribute: string | null;
  role_mapping: IdentityProvider['role_mapping'];
  allowed_email_domains: string[];
  jit_provisioning: boolean;
  default_role: IdentityProvider['default_role'];
  trust_idp_mfa: boolean;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `SELECT id, kind, name, enabled, oidc_issuer, oidc_client_id, (oidc_client_secret_enc IS NOT NULL) AS oidc_client_secret_set,
  oidc_scopes, saml_entry_point, saml_idp_entity_id, saml_idp_cert, saml_request_binding, email_attribute, name_attribute, role_attribute,
  role_mapping, allowed_email_domains, jit_provisioning, default_role, trust_idp_mfa, created_at, updated_at FROM identity_providers`;

async function present(organizationId: string, rows: Row[]): Promise<IdentityProvider[]> {
  // user_identities is a system-only identity table: counted per provider of THIS organization.
  const counts = await systemPool.query<{ provider_id: string; n: number }>(
    `SELECT provider_id, count(*)::int AS n FROM user_identities WHERE organization_id = $1 GROUP BY provider_id`,
    [organizationId],
  );
  const n = new Map(counts.rows.map((c) => [c.provider_id, c.n]));
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    linked_users: n.get(r.id) ?? 0,
    service_provider: serviceProviderUrls(r.id),
  }));
}

/** What an audit row may say about a change: field names, never values of secrets. */
const changedFields = (body: Record<string, unknown>) => Object.keys(body).map((k) => (k === 'oidc_client_secret' ? 'oidc_client_secret (set)' : k));

// Admins may read the providers and run the check; only the OWNER creates, changes or deletes one.
// An identity provider can sign in as ANY member of the organization by email (and, with
// trust_idp_mfa, without their TOTP), so whoever controls the provider can become any member:
// an admin with that power could impersonate the owner or a second admin (two-person approvals).
// See docs/security/review-2026-11.md (SEC-01).
ssoAdminRouter.get('/sso/providers', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const rows = await withTenant(ctx.organizationId, (db) => db.query<Row>(`${SELECT} ORDER BY name`));
  res.json({ items: await present(ctx.organizationId, rows.rows) });
});

ssoAdminRouter.post('/sso/providers', requireRole('owner'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(createSchema, req.body);
  const row = await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<Row>(
      `INSERT INTO identity_providers (organization_id, kind, name, enabled, oidc_issuer, oidc_client_id, oidc_client_secret_enc, oidc_scopes,
         saml_entry_point, saml_idp_entity_id, saml_idp_cert, saml_request_binding, email_attribute, name_attribute, role_attribute,
         role_mapping, allowed_email_domains, jit_provisioning, default_role, trust_idp_mfa, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [
        ctx.organizationId,
        body.kind,
        body.name,
        body.enabled,
        body.kind === 'oidc' ? body.oidc_issuer : null,
        body.kind === 'oidc' ? body.oidc_client_id : null,
        body.kind === 'oidc' && body.oidc_client_secret ? encryptSecret(body.oidc_client_secret) : null,
        body.kind === 'oidc' ? body.oidc_scopes : 'openid email profile',
        body.kind === 'saml' ? body.saml_entry_point : null,
        body.kind === 'saml' ? body.saml_idp_entity_id : null,
        body.kind === 'saml' ? body.saml_idp_cert : null,
        body.kind === 'saml' ? body.saml_request_binding : 'redirect',
        body.email_attribute,
        body.name_attribute,
        body.role_attribute,
        JSON.stringify(body.role_mapping),
        body.allowed_email_domains,
        body.jit_provisioning,
        body.default_role,
        body.trust_idp_mfa,
        ctx.userId,
      ],
    );
    const id = r.rows[0]!.id;
    await audit(db, req, 'sso.provider_created', { type: 'identity_provider', id }, { kind: body.kind, name: body.name, domains: body.allowed_email_domains, jit_provisioning: body.jit_provisioning, trust_idp_mfa: body.trust_idp_mfa });
    return (await db.query<Row>(`${SELECT} WHERE id = $1`, [id])).rows[0]!;
  });
  res.status(201).json((await present(ctx.organizationId, [row]))[0]);
});

ssoAdminRouter.patch('/sso/providers/:id', requireRole('owner'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(updateSchema, req.body);
  const row = await withTenant(ctx.organizationId, async (db) => {
    const current = await db.query<{ kind: 'oidc' | 'saml' }>(`SELECT kind FROM identity_providers WHERE id = $1 FOR UPDATE`, [id]);
    const kind = current.rows[0]?.kind;
    if (!kind) throw notFound('Identity provider');
    const wrongKind = Object.keys(body).filter((k) => (kind === 'oidc' ? k.startsWith('saml_') : k.startsWith('oidc_') || k === 'clear_oidc_client_secret'));
    if (wrongKind.length) throw new AppError(400, 'validation_error', 'Fields of the other provider type', wrongKind.map((path) => ({ path, message: `Not a ${kind.toUpperCase()} setting` })));

    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || k === 'oidc_client_secret' || k === 'clear_oidc_client_secret') continue;
      set(k, k === 'role_mapping' ? JSON.stringify(v) : v);
    }
    if (body.oidc_client_secret) set('oidc_client_secret_enc', encryptSecret(body.oidc_client_secret));
    else if (body.clear_oidc_client_secret) set('oidc_client_secret_enc', null);
    if (sets.length) await db.query(`UPDATE identity_providers SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values);
    await audit(db, req, 'sso.provider_updated', { type: 'identity_provider', id }, { fields: changedFields(body) });
    return (await db.query<Row>(`${SELECT} WHERE id = $1`, [id])).rows[0]!;
  });
  res.json((await present(ctx.organizationId, [row]))[0]);
});

ssoAdminRouter.delete('/sso/providers/:id', requireRole('owner'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await withTenant(ctx.organizationId, async (db) => {
    const r = await db.query<{ name: string; kind: string }>(`DELETE FROM identity_providers WHERE id = $1 RETURNING name, kind`, [id]);
    if (!r.rowCount) throw notFound('Identity provider');
    // Sessions started through it end with it (sessions.sso_provider_id ON DELETE CASCADE).
    await audit(db, req, 'sso.provider_deleted', { type: 'identity_provider', id }, { name: r.rows[0]!.name, kind: r.rows[0]!.kind });
  });
  res.status(204).end();
});

/** A real check of the configuration: OIDC discovery is fetched and validated; a SAML certificate is read. */
ssoAdminRouter.post('/sso/providers/:id/check', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const row = await withTenant(ctx.organizationId, async (db) => (await db.query<Row>(`${SELECT} WHERE id = $1`, [id])).rows[0]);
  if (!row) throw notFound('Identity provider');
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  if (row.kind === 'oidc') {
    try {
      const doc = await discover(row.oidc_issuer!, { fresh: true });
      checks.push({ check: 'discovery', ok: true, detail: doc.issuer });
      checks.push({ check: 'authorization_endpoint', ok: true, detail: doc.authorization_endpoint });
      checks.push({ check: 'token_endpoint', ok: true, detail: doc.token_endpoint });
      checks.push({ check: 'jwks_uri', ok: true, detail: doc.jwks_uri });
    } catch (err) {
      checks.push({ check: 'discovery', ok: false, detail: err instanceof SsoError ? err.message : 'Discovery failed' });
    }
    checks.push({ check: 'client_secret', ok: true, detail: row.oidc_client_secret_set ? 'set' : 'none (public client, PKCE only)' });
  } else {
    const cert = new X509Certificate(row.saml_idp_cert!);
    const expires = new Date(cert.validTo);
    const daysLeft = Math.floor((expires.getTime() - Date.now()) / 86_400_000);
    checks.push({ check: 'certificate', ok: daysLeft > 0, detail: `${cert.subject.replace(/\n/g, ', ')}; valid until ${expires.toISOString()} (${daysLeft} days); SHA-256 ${cert.fingerprint256}` });
    const problem = idpUrlProblem(row.saml_entry_point!);
    checks.push({ check: 'entry_point', ok: problem === null, detail: problem ?? row.saml_entry_point! });
  }
  await withTenant(ctx.organizationId, (db) => audit(db, req, 'sso.provider_checked', { type: 'identity_provider', id }, { ok: checks.every((c) => c.ok) }));
  res.json({ ok: checks.every((c) => c.ok), checks });
});
