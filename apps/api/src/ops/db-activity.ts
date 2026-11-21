import type pg from 'pg';

/** The API's pools identify themselves with these (infrastructure/db.ts). */
export const API_APPLICATION_NAMES = ['ld-system', 'ld-app'] as const;

export interface OtherSession {
  pid: number;
  applicationName: string;
  user: string;
  /** True when the session belongs to an API instance (its pool's application_name or the lan_app role). */
  api: boolean;
}

/** Every other session connected to `database` (default: the client's own), never the query text. */
export async function otherSessions(client: pg.Client, database?: string): Promise<OtherSession[]> {
  const res = await client.query<{ pid: number; application_name: string; usename: string | null }>(
    `SELECT pid, coalesce(application_name, '') AS application_name, usename
       FROM pg_stat_activity
      WHERE datname = coalesce($1, current_database()) AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
    [database ?? null],
  );
  return res.rows.map((r) => ({
    pid: r.pid,
    applicationName: r.application_name,
    user: r.usename ?? '',
    api: (API_APPLICATION_NAMES as readonly string[]).includes(r.application_name) || r.usename === 'lan_app',
  }));
}

/** Ends the given sessions; returns how many were ended. */
export async function terminateSessions(client: pg.Client, pids: readonly number[]): Promise<number> {
  if (pids.length === 0) return 0;
  const res = await client.query<{ ok: boolean }>('SELECT pg_terminate_backend(pid) AS ok FROM unnest($1::int[]) AS pid', [pids]);
  return res.rows.filter((r) => r.ok).length;
}

export function describeSessions(sessions: readonly OtherSession[]): string {
  const byName = new Map<string, number>();
  for (const s of sessions) {
    const label = s.applicationName || `(no application name, role ${s.user || 'unknown'})`;
    byName.set(label, (byName.get(label) ?? 0) + 1);
  }
  return [...byName].map(([name, n]) => `${n} × ${name}`).join(', ');
}

/**
 * Audit row for an operations tool run from a shell (no signed-in user): actor 'system',
 * metadata.tool names the tool. One row per organization, since audit_logs is per organization.
 * Must run inside the caller's transaction. Returns the number of rows written.
 */
export async function auditOperation(
  client: pg.Client,
  action: string,
  target: { type: string; id?: string | null },
  metadataFor: (organizationId: string) => Record<string, unknown>,
): Promise<number> {
  const orgs = await client.query<{ id: string }>('SELECT id FROM organizations ORDER BY created_at');
  for (const o of orgs.rows) {
    await client.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
       VALUES ($1, NULL, NULL, $2, $3, $4, $5, 'system')`,
      [o.id, action, target.type, target.id ?? null, JSON.stringify(metadataFor(o.id))],
    );
  }
  return orgs.rows.length;
}
