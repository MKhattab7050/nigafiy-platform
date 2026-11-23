import type { KnowledgeEntry, KnowledgeRevision } from '@nigafiy/shared-types';
import type { Db } from '../../infrastructure/db.ts';

/**
 * The entry row as the API returns it. `$1` is always the caller's user id (for `my_vote`); callers
 * append their own WHERE clause with parameters starting at `$2`.
 */
export const ENTRY_SELECT = `
  SELECT k.id, k.status, k.source, k.kind, k.title, k.symptoms, k.cause, k.cause_source, k.fix_steps,
         k.tags, k.rule_ids, k.incident_kinds, k.event_types, k.device_types, k.vendors,
         k.site_id, s.name AS site_name,
         k.device_id, coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS device_name,
         k.check_id, c.name AS check_name,
         k.incident_id, i.number AS incident_number,
         k.fault_domain, k.diagnosis_summary, k.diagnosis_confidence, k.incident_duration_seconds,
         k.edited, k.revision,
         coalesce(v.helpful, 0)::int AS helpful, coalesce(v.not_helpful, 0)::int AS not_helpful,
         (SELECT count(*) FROM knowledge_uses u WHERE u.entry_id = k.id)::int AS uses,
         (SELECT mv.helpful FROM knowledge_votes mv WHERE mv.entry_id = k.id AND mv.user_id = $1::uuid) AS my_vote,
         k.created_by_name, k.updated_by_name, k.published_by_name, k.published_at, k.created_at, k.updated_at
    FROM knowledge_entries k
    LEFT JOIN sites s ON s.organization_id = k.organization_id AND s.id = k.site_id
    LEFT JOIN devices d ON d.organization_id = k.organization_id AND d.id = k.device_id
    LEFT JOIN monitoring_checks c ON c.organization_id = k.organization_id AND c.id = k.check_id
    LEFT JOIN incidents i ON i.organization_id = k.organization_id AND i.id = k.incident_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE helpful) AS helpful, count(*) FILTER (WHERE NOT helpful) AS not_helpful
        FROM knowledge_votes WHERE entry_id = k.id) v ON true`;

export type EntryRow = Omit<KnowledgeEntry, 'published_at' | 'created_at' | 'updated_at'> & { published_at: Date | null; created_at: Date; updated_at: Date };

export function formatEntry(r: EntryRow): KnowledgeEntry {
  return {
    ...r,
    published_at: r.published_at ? new Date(r.published_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

export async function loadEntry(db: Db, userId: string, id: string): Promise<KnowledgeEntry | null> {
  const row = (await db.query<EntryRow>(`${ENTRY_SELECT} WHERE k.id = $2`, [userId, id])).rows[0];
  return row ? formatEntry(row) : null;
}

/** The content fields a revision snapshots. */
export const SNAPSHOT_FIELDS = ['title', 'symptoms', 'cause', 'cause_source', 'fix_steps', 'kind', 'tags', 'rule_ids', 'incident_kinds', 'event_types', 'device_types', 'vendors'] as const;

/** Append a revision with a snapshot of the entry's current content (inside the caller's transaction). */
export async function addRevision(db: Db, organizationId: string, entryId: string, action: KnowledgeRevision['action'], who: { id: string; name: string } | null): Promise<void> {
  await db.query(
    `INSERT INTO knowledge_revisions (organization_id, entry_id, revision, action, snapshot, user_id, user_name)
     SELECT organization_id, id, revision, $3,
            jsonb_build_object(${SNAPSHOT_FIELDS.map((f) => `'${f}', ${f}`).join(', ')}),
            $4, $5
       FROM knowledge_entries WHERE organization_id = $1 AND id = $2`,
    [organizationId, entryId, action, who?.id ?? null, who?.name ?? null],
  );
}
