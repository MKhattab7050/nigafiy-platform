import type { Db } from '../../infrastructure/db.ts';

// Queue `run_checks` / `run_discovery` for the online collectors of a site (or of every site), from
// another module (playbooks), inside the caller's tenant transaction. Same rules as
// POST /collectors/:id/scan and POST /doctor/run-checks: active, online collectors only, and a command
// already waiting is reused instead of queueing a second one. The caller audits.

export type SiteCommandKind = 'run_checks' | 'run_discovery';

export interface SiteCommandQueued {
  collector_id: string;
  collector: string;
  site_id: string;
  command_id: string;
  /** false: a command of this kind was already waiting and is reused. */
  queued: boolean;
}

export async function queueSiteCollectorCommand(
  db: Db,
  organizationId: string,
  siteId: string | null,
  kind: SiteCommandKind,
  createdBy: string | null,
): Promise<SiteCommandQueued[]> {
  const collectors = (
    await db.query<{ id: string; name: string; site_id: string }>(
      `SELECT id, name, site_id FROM collectors
        WHERE status = 'active' AND connection_state = 'online' AND ($1::uuid IS NULL OR site_id = $1)
        ORDER BY name, id`,
      [siteId],
    )
  ).rows;
  const out: SiteCommandQueued[] = [];
  for (const c of collectors) {
    const pending = (
      await db.query<{ id: string }>(`SELECT id FROM collector_commands WHERE collector_id = $1 AND kind = $2 AND status <> 'completed' ORDER BY created_at LIMIT 1`, [c.id, kind])
    ).rows[0];
    if (pending) {
      out.push({ collector_id: c.id, collector: c.name, site_id: c.site_id, command_id: pending.id, queued: false });
      continue;
    }
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO collector_commands (organization_id, collector_id, kind, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [organizationId, c.id, kind, createdBy],
    );
    out.push({ collector_id: c.id, collector: c.name, site_id: c.site_id, command_id: inserted.rows[0]!.id, queued: true });
  }
  return out;
}

/** Status of collector commands (pending / delivered / completed) by id. */
export async function collectorCommandStates(db: Db, ids: string[]): Promise<{ id: string; kind: string; status: string; completed_at: Date | null }[]> {
  if (!ids.length) return [];
  return (await db.query<{ id: string; kind: string; status: string; completed_at: Date | null }>(`SELECT id, kind, status, completed_at FROM collector_commands WHERE id = ANY($1)`, [ids])).rows;
}
