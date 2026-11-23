import { z } from 'zod';
import type { IdentityProviderRoleMapping, Role, SsoAssignableRole } from '@nigafiy/shared-types';
import { hashPassword, randomToken } from '../../../common/crypto.ts';
import type { Db } from '../../../infrastructure/db.ts';
import { SsoError, emailDomain } from './config.ts';

export interface ProviderRow {
  id: string;
  organization_id: string;
  kind: 'oidc' | 'saml';
  name: string;
  enabled: boolean;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_enc: string | null;
  oidc_scopes: string;
  saml_entry_point: string | null;
  saml_idp_entity_id: string | null;
  saml_idp_cert: string | null;
  saml_request_binding: 'redirect' | 'post';
  email_attribute: string;
  name_attribute: string | null;
  role_attribute: string | null;
  role_mapping: IdentityProviderRoleMapping[];
  allowed_email_domains: string[];
  jit_provisioning: boolean;
  default_role: SsoAssignableRole;
  trust_idp_mfa: boolean;
}

/** What an identity provider asserted, reduced to what Nigafiy uses. */
export interface SsoClaims {
  subject: string;
  email: string | null;
  /** OIDC email_verified when present; SAML: undefined. */
  emailVerified?: boolean;
  name: string | null;
  roleValues: string[];
}

const RANK: Record<SsoAssignableRole, number> = { viewer: 0, technician: 1, admin: 2 };

/** The highest role any of the asserted values maps to, or null when none maps. */
export function mappedRole(mapping: readonly IdentityProviderRoleMapping[], values: readonly string[]): SsoAssignableRole | null {
  let best: SsoAssignableRole | null = null;
  for (const m of mapping) {
    if (values.includes(m.value) && (best === null || RANK[m.role] > RANK[best])) best = m.role;
  }
  return best;
}

/** A claim / attribute as a list of strings (single values, arrays, numbers and booleans are accepted). */
export function claimValues(source: Record<string, unknown>, name: string | null): string[] {
  if (!name) return [];
  const v = source[name];
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.filter((x) => ['string', 'number', 'boolean'].includes(typeof x)).map(String).slice(0, 200);
}

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export interface ResolvedSsoUser {
  userId: string;
  email: string;
  role: Role;
  jitCreated: boolean;
  roleChangedFrom: Role | null;
  hasTotp: boolean;
}

/**
 * Finds (or, with JIT provisioning, creates) the Nigafiy user an SSO sign-in stands for, inside the
 * caller's system transaction. Rules:
 *  - the email must be present, valid, verified (when the IdP says), and in an allowed domain;
 *  - a known subject (user_identities) wins; otherwise the user is matched by email;
 *  - the user must have an active membership in the provider's organization, or JIT must be on;
 *  - JIT never attaches an EXISTING account to the organization (that needs an invitation, which the
 *    account holder accepts with their password): it only creates brand-new users;
 *  - role mapping applies on every sign-in, never to an owner, and never grants "owner".
 */
export async function resolveSsoUser(db: Db, p: ProviderRow, c: SsoClaims): Promise<ResolvedSsoUser> {
  const parsedEmail = emailSchema.safeParse(c.email ?? '');
  if (!parsedEmail.success) throw new SsoError('sso_no_email', 'The identity provider did not send a valid email address');
  const email = parsedEmail.data;
  if (c.emailVerified === false) throw new SsoError('sso_email_unverified', 'The identity provider says this email address is not verified');
  if (!p.allowed_email_domains.includes(emailDomain(email))) {
    throw new SsoError('sso_domain_not_allowed', 'This email domain may not sign in through this identity provider');
  }
  const mapped = mappedRole(p.role_mapping, c.roleValues);

  const linked = await db.query<{ user_id: string }>(`SELECT user_id FROM user_identities WHERE provider_id = $1 AND subject = $2`, [p.id, c.subject]);
  let userId = linked.rows[0]?.user_id ?? null;
  if (!userId) {
    const byEmail = await db.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [email]);
    userId = byEmail.rows[0]?.id ?? null;
  }

  let jitCreated = false;
  let roleChangedFrom: Role | null = null;
  let role: Role;
  if (userId) {
    const m = await db.query<{ role: Role; status: string }>(
      `SELECT role, status FROM memberships WHERE user_id = $1 AND organization_id = $2 FOR UPDATE`,
      [userId, p.organization_id],
    );
    const membership = m.rows[0];
    if (!membership) {
      throw new SsoError(
        p.jit_provisioning ? 'sso_account_exists' : 'sso_not_member',
        p.jit_provisioning
          ? 'An account with this email already exists; ask an administrator for an invitation to this organization'
          : 'You are not a member of this organization; ask an administrator for an invitation',
      );
    }
    if (membership.status !== 'active') throw new SsoError('account_deactivated', 'Your account has been deactivated in this organization');
    role = membership.role;
    if (mapped && role !== 'owner' && mapped !== role) {
      await db.query(`UPDATE memberships SET role = $3 WHERE user_id = $1 AND organization_id = $2`, [userId, p.organization_id, mapped]);
      await db.query(
        `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata)
         VALUES ($1,$2,$3,'sso.role_synced','user',$5,$4)`,
        [p.organization_id, userId, email, JSON.stringify({ provider_id: p.id, provider: p.name, from: role, to: mapped }), userId],
      );
      roleChangedFrom = role;
      role = mapped;
    }
  } else {
    if (!p.jit_provisioning) throw new SsoError('sso_not_member', 'You are not a member of this organization; ask an administrator for an invitation');
    role = mapped ?? p.default_role;
    const displayName = (c.name?.trim() || email.split('@')[0] || 'User').slice(0, 80);
    // No local password: an unguessable one is stored; the user can set one through "Forgot password".
    const created = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id`,
      [email, await hashPassword(randomToken(32)), displayName],
    );
    userId = created.rows[0]!.id;
    await db.query(`INSERT INTO memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [userId, p.organization_id, role]);
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata)
       VALUES ($1,$2,$3,'sso.user_provisioned','user',$5,$4)`,
      [p.organization_id, userId, email, JSON.stringify({ provider_id: p.id, provider: p.name, role }), userId],
    );
    jitCreated = true;
  }

  await db.query(
    `INSERT INTO user_identities (provider_id, organization_id, subject, user_id, email, last_login_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (provider_id, subject) DO UPDATE SET email = EXCLUDED.email, last_login_at = now()`,
    [p.id, p.organization_id, c.subject, userId, email],
  );
  const u = await db.query<{ email: string; has_totp: boolean }>(`SELECT email, (mfa_secret_enc IS NOT NULL) AS has_totp FROM users WHERE id = $1`, [userId]);
  return { userId, email: u.rows[0]!.email, role, jitCreated, roleChangedFrom, hasTotp: u.rows[0]!.has_totp };
}
