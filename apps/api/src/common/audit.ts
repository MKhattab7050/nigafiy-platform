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

export type AuditActor = 'user' | 'system' | 'collector';

export interface SystemAuditEntry {
  /** The automation key (modules/automation catalogue) that took the action; stored as metadata.automation. */
  automation: string;
  action: string;
  target: { type: string; id?: string | null } | null;
  /** The site the action concerned; stored as metadata.site_id (the automation's "last effect" is counted per site). */
  siteId?: string | null;
  metadata?: Record<string, unknown>;
  /** 'system' (default): LAN Detective decided on its own. 'collector': a collector's report triggered it. */
  actor?: Exclude<AuditActor, 'user'>;
}

/**
 * Record an action LAN Detective took by itself (no user involved), inside the caller's transaction.
 * Works in tenant and platform transactions alike: the organization is set explicitly.
 */
export async function auditSystem(db: Db, organizationId: string, entry: SystemAuditEntry): Promise<void> {
  const metadata = { ...entry.metadata, automation: entry.automation, ...(entry.siteId ? { site_id: entry.siteId } : {}) };
  await db.query(
    `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
     VALUES ($1,NULL,NULL,$2,$3,$4,$5,$6)`,
    [organizationId, entry.action, entry.target?.type ?? null, entry.target?.id ?? null, JSON.stringify(metadata), entry.actor ?? 'system'],
  );
}
