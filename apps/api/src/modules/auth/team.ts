import { type Request, Router } from 'express';
import { z } from 'zod';
import {
  type InvitationCreated,
  type MfaRequirement,
  type PasswordResetIssued,
  ROLES,
  type Role,
  type TeamInvitation,
  type TeamMember,
  type TeamOverview,
} from '@lan-detective/shared-types';
import { randomToken, sha256 } from '../../common/crypto.ts';
import { AppError, auth, forbidden, idParams, notFound, parse, requireRole } from '../../common/http.ts';
import { env } from '../../config/env.ts';
import { systemPool, withSystem } from '../../infrastructure/db.ts';
import { accountMailConfigured, sendAccountEmail } from '../notifications/index.ts';

export const teamRouter: Router = Router();

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const userIdParams = z.object({ userId: z.uuid() });

export function webAppUrl(_req?: Request): string {
  return (env.PUBLIC_URL || env.WEB_ORIGIN).replace(/\/+$/, '');
}

const MEMBER_SELECT = `
  SELECT u.id, u.display_name, u.email, m.role, m.status,
         (u.mfa_secret_enc IS NOT NULL) AS mfa_enabled,
         u.last_login_at, m.created_at AS joined_at, m.deactivated_at
    FROM memberships m
    JOIN users u ON u.id = m.user_id`;

teamRouter.get('/team', async (req, res) => {
  const ctx = auth(req);
  const [members, invitations, org, mailConfigured] = await Promise.all([
    systemPool.query<TeamMember>(
      `${MEMBER_SELECT}
        WHERE m.organization_id = $1
        ORDER BY (m.status = 'active') DESC,
                 array_position(ARRAY['owner','admin','technician','viewer'], m.role),
                 u.display_name, u.email`,
      [ctx.organizationId],
    ),
    systemPool.query<TeamInvitation>(
      `SELECT id, email, role, invited_by_name, created_at, expires_at
         FROM invitations
        WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [ctx.organizationId],
    ),
    systemPool.query<{ mfa_required: MfaRequirement }>(
      `SELECT mfa_required FROM organizations WHERE id = $1`,
      [ctx.organizationId],
    ),
    accountMailConfigured(ctx.organizationId),
  ]);

  const overview: TeamOverview = {
    members: members.rows,
    invitations: invitations.rows,
    mfa_required: org.rows[0]?.mfa_required ?? 'off',
    account_mail_configured: mailConfigured,
  };
  res.json(overview);
});

teamRouter.post('/team/invitations', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(
    z
      .object({
        email: emailSchema,
        role: z.enum(ROLES).default('technician'),
      })
      .strict(),
    req.body,
  );

  if (body.role === 'owner' && ctx.role !== 'owner') {
    throw forbidden('Only an organization owner can invite another owner');
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);

  const created = await withSystem(async (db) => {
    const existingMember = await db.query(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND lower(u.email) = $2`,
      [ctx.organizationId, body.email],
    );
    if (existingMember.rowCount) {
      throw new AppError(409, 'already_member', 'This user is already a member of the organization');
    }

    // Revoke any expired unaccepted invitations so the partial unique index allows a fresh one
    await db.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE organization_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
      [ctx.organizationId, body.email],
    );

    const openInvite = await db.query(
      `SELECT 1 FROM invitations
        WHERE organization_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [ctx.organizationId, body.email],
    );
    if (openInvite.rowCount) {
      throw new AppError(409, 'invitation_exists', 'An open invitation for this email already exists');
    }

    const inviterRes = await db.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [ctx.userId]);
    const orgRes = await db.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [ctx.organizationId]);
    const inviterName = inviterRes.rows[0]?.display_name ?? ctx.userEmail;
    const orgName = orgRes.rows[0]?.name ?? 'LAN Detective';

    const inserted = await db.query<TeamInvitation>(
      `INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, invited_by_name, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, email, role, invited_by_name, created_at, expires_at`,
      [ctx.organizationId, body.email, body.role, sha256(token), ctx.userId, inviterName, expiresAt],
    );
    return { invitation: inserted.rows[0]!, inviterName, orgName };
  });

  const inviteUrl = `${webAppUrl(req)}/invite/${encodeURIComponent(token)}`;
  const mailOutcome = await sendAccountEmail(ctx.organizationId, body.email, {
    subject: `[LAN Detective] Invitation to join ${created.orgName}`,
    text: [
      `${created.inviterName} invited you to join ${created.orgName} on LAN Detective as ${body.role}.`,
      '',
      `Accept your invitation: ${inviteUrl}`,
      `Expires: ${expiresAt.toISOString()}`,
    ].join('\n'),
  });

  await systemPool.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
     VALUES ($1,$2,$3,'invitation.created','invitation',$4,$5,$6)`,
    [
      ctx.organizationId,
      ctx.userId,
      ctx.userEmail,
      created.invitation.id,
      JSON.stringify({ email: body.email, role: body.role, mail_outcome: mailOutcome }),
      req.ip ?? null,
    ],
  );

  const response: InvitationCreated = {
    invitation: created.invitation,
    mail_outcome: mailOutcome,
    invite_url: inviteUrl,
    token,
  };
  res.status(201).json(response);
});

teamRouter.delete('/team/invitations/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);

  await withSystem(async (db) => {
    const revoked = await db.query<{ email: string; role: Role }>(
      `UPDATE invitations SET revoked_at = now()
        WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING email, role`,
      [id, ctx.organizationId],
    );
    if (!revoked.rowCount) throw notFound('Invitation');
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
       VALUES ($1,$2,$3,'invitation.revoked','invitation',$4,$5,$6)`,
      [
        ctx.organizationId,
        ctx.userId,
        ctx.userEmail,
        id,
        JSON.stringify({ email: revoked.rows[0]!.email, role: revoked.rows[0]!.role }),
        req.ip ?? null,
      ],
    );
  });

  res.status(204).end();
});

teamRouter.patch('/team/members/:userId', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { userId } = parse(userIdParams, req.params);
  const body = parse(
    z
      .object({
        role: z.enum(ROLES).optional(),
        status: z.enum(['active', 'deactivated']).optional(),
      })
      .strict()
      .refine((b) => b.role !== undefined || b.status !== undefined, 'Provide role or status'),
    req.body,
  );

  if (userId === ctx.userId && body.status === 'deactivated') {
    throw new AppError(409, 'cannot_deactivate_self', 'You cannot deactivate your own account');
  }

  const member = await withSystem(async (db) => {
    const currentRes = await db.query<{ role: Role; status: 'active' | 'deactivated'; email: string }>(
      `SELECT m.role, m.status, u.email
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.user_id = $2
        FOR UPDATE OF m`,
      [ctx.organizationId, userId],
    );
    const current = currentRes.rows[0];
    if (!current) throw notFound('Member');

    if ((current.role === 'owner' || body.role === 'owner') && ctx.role !== 'owner') {
      throw forbidden('Only an organization owner can manage owners');
    }

    const nextRole = body.role ?? current.role;
    const nextStatus = body.status ?? current.status;

    if (current.role === 'owner' && current.status === 'active' && (nextRole !== 'owner' || nextStatus !== 'active')) {
      const otherOwners = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM memberships
          WHERE organization_id = $1 AND role = 'owner' AND status = 'active' AND user_id <> $2`,
        [ctx.organizationId, userId],
      );
      if (otherOwners.rows[0]!.n === 0) {
        throw new AppError(409, 'last_owner', 'The organization must keep at least one active owner');
      }
    }

    await db.query(
      `UPDATE memberships
          SET role = $3,
              status = $4,
              deactivated_at = CASE WHEN $4 = 'deactivated' THEN coalesce(deactivated_at, now()) ELSE NULL END,
              deactivated_by = CASE WHEN $4 = 'deactivated' THEN coalesce(deactivated_by, $5) ELSE NULL END
        WHERE organization_id = $1 AND user_id = $2`,
      [ctx.organizationId, userId, nextRole, nextStatus, ctx.userId],
    );

    if (nextStatus === 'deactivated') {
      await db.query(`DELETE FROM sessions WHERE user_id = $1 AND active_organization_id = $2`, [
        userId,
        ctx.organizationId,
      ]);
    }

    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
       VALUES ($1,$2,$3,'member.updated','member',$4,$5,$6)`,
      [
        ctx.organizationId,
        ctx.userId,
        ctx.userEmail,
        userId,
        JSON.stringify({
          email: current.email,
          role: nextRole,
          status: nextStatus,
          previous_role: current.role,
          previous_status: current.status,
        }),
        req.ip ?? null,
      ],
    );

    const updated = await db.query<TeamMember>(
      `${MEMBER_SELECT} WHERE m.organization_id = $1 AND m.user_id = $2`,
      [ctx.organizationId, userId],
    );
    return updated.rows[0]!;
  });

  res.json({ ok: true, ...member });
});

teamRouter.delete('/team/members/:userId', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { userId } = parse(userIdParams, req.params);

  if (userId === ctx.userId) {
    throw new AppError(409, 'cannot_remove_self', 'You cannot remove yourself from the organization');
  }

  await withSystem(async (db) => {
    const currentRes = await db.query<{ role: Role; status: 'active' | 'deactivated'; email: string }>(
      `SELECT m.role, m.status, u.email
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.user_id = $2
        FOR UPDATE OF m`,
      [ctx.organizationId, userId],
    );
    const current = currentRes.rows[0];
    if (!current) throw notFound('Member');

    if (current.role === 'owner' && ctx.role !== 'owner') {
      throw forbidden('Only an organization owner can remove an owner');
    }

    if (current.role === 'owner' && current.status === 'active') {
      const otherOwners = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM memberships
          WHERE organization_id = $1 AND role = 'owner' AND status = 'active' AND user_id <> $2`,
        [ctx.organizationId, userId],
      );
      if (otherOwners.rows[0]!.n === 0) {
        throw new AppError(409, 'last_owner', 'The organization must keep at least one active owner');
      }
    }

    await db.query(`DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2`, [
      ctx.organizationId,
      userId,
    ]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1 AND active_organization_id = $2`, [
      userId,
      ctx.organizationId,
    ]);

    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
       VALUES ($1,$2,$3,'member.removed','member',$4,$5,$6)`,
      [
        ctx.organizationId,
        ctx.userId,
        ctx.userEmail,
        userId,
        JSON.stringify({ email: current.email, role: current.role }),
        req.ip ?? null,
      ],
    );
  });

  res.status(204).end();
});

teamRouter.post('/team/members/:userId/reset-password', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { userId } = parse(userIdParams, req.params);

  const memberRes = await systemPool.query<{ role: Role; email: string; display_name: string }>(
    `SELECT m.role, u.email, u.display_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.user_id = $2`,
    [ctx.organizationId, userId],
  );
  const member = memberRes.rows[0];
  if (!member) throw notFound('Member');

  if (member.role === 'owner' && ctx.role !== 'owner') {
    throw forbidden('Only an organization owner can reset an owner’s password');
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + 60 * 60_000);

  await systemPool.query(
    `INSERT INTO auth_tokens (user_id, organization_id, purpose, token_hash, created_by, expires_at)
     VALUES ($1,$2,'password_reset',$3,$4,$5)`,
    [userId, ctx.organizationId, sha256(token), ctx.userId, expiresAt],
  );

  const resetUrl = `${webAppUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
  const mailOutcome = await sendAccountEmail(ctx.organizationId, member.email, {
    subject: '[LAN Detective] Password reset link',
    text: [
      `An administrator (${ctx.userEmail}) issued a password reset link for your LAN Detective account.`,
      '',
      `Reset your password: ${resetUrl}`,
      `Expires: ${expiresAt.toISOString()}`,
    ].join('\n'),
  });

  await systemPool.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
     VALUES ($1,$2,$3,'member.password_reset_issued','member',$4,$5,$6)`,
    [
      ctx.organizationId,
      ctx.userId,
      ctx.userEmail,
      userId,
      JSON.stringify({ email: member.email, mail_outcome: mailOutcome }),
      req.ip ?? null,
    ],
  );

  const response: PasswordResetIssued = {
    mail_outcome: mailOutcome,
    reset_url: resetUrl,
    token,
    expires_at: expiresAt.toISOString(),
  };
  res.json(response);
});

teamRouter.patch('/team/security', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(
    z.object({
      mfa_required: z.enum(['off', 'admins', 'all']),
    }).strict(),
    req.body,
  );

  await withSystem(async (db) => {
    await db.query(`UPDATE organizations SET mfa_required = $2 WHERE id = $1`, [
      ctx.organizationId,
      body.mfa_required,
    ]);
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
       VALUES ($1,$2,$3,'organization.security_updated','organization',$4,$5,$6)`,
      [
        ctx.organizationId,
        ctx.userId,
        ctx.userEmail,
        ctx.organizationId,
        JSON.stringify({ mfa_required: body.mfa_required }),
        req.ip ?? null,
      ],
    );
  });

  res.json({ mfa_required: body.mfa_required });
});
