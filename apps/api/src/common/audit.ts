import type { Request } from 'express';
import type { Db } from '../infrastructure/db.ts';
import { auth } from './http.ts';

/** Append an audit record inside the caller's transaction, so the action and its audit trail commit together. */
export async function audit(
  db: Db,
  req: Request,
  action: string,
  target: { type: string; id?: string | null } | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const ctx = auth(req);
  await db.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.organizationId, ctx.userId, ctx.userEmail, action, target?.type ?? null, target?.id ?? null, JSON.stringify(metadata), req.ip ?? null],
  );
}
