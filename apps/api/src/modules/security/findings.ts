import type { Db } from '../../infrastructure/db.ts';

export type FindingCategory = 'dhcp' | 'upnp' | 'wifi';
export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface FindingInput {
  kind: string;
  key: string;
  severity: FindingSeverity;
  title: string;
  details: Record<string, unknown>;
  deviceId?: string | null;
}

/**
 * Makes the stored findings of one category match what the latest report shows.
 *
 *  - every finding in `current` is upserted as open (a resolved one re-opens with a new first_seen_at);
 *  - every open finding of the category whose key starts with `keyPrefix` and is not in `current`
 *    is resolved with `resolution` — the prefix keeps one collector's report from resolving
 *    another collector's findings (Wi-Fi), or limits it to the gateways a report covered (UPnP).
 *
 * Returns the findings that were newly opened, so the caller can raise events for them.
 */
export async function syncFindings(
  db: Db,
  organizationId: string,
  siteId: string,
  category: FindingCategory,
  current: FindingInput[],
  now: Date,
  opts: { keyPrefixes?: string[]; resolution?: string; kinds?: string[] } = {},
): Promise<FindingInput[]> {
  const existing = await db.query<{ kind: string; key: string; status: string }>(
    `SELECT kind, key, status FROM security_findings WHERE organization_id = $1 AND site_id = $2 AND category = $3`,
    [organizationId, siteId, category],
  );
  const state = new Map(existing.rows.map((r) => [`${r.kind}\u0000${r.key}`, r.status]));
  const opened: FindingInput[] = [];
  const seen = new Set<string>();
  for (const f of current) {
    const id = `${f.kind}\u0000${f.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const before = state.get(id);
    if (before !== 'open') opened.push(f);
    await db.query(
      `INSERT INTO security_findings (organization_id, site_id, category, kind, key, severity, title, details, device_id, status, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$10)
       ON CONFLICT (organization_id, site_id, kind, key) DO UPDATE
          SET severity = EXCLUDED.severity, title = EXCLUDED.title, details = EXCLUDED.details, device_id = EXCLUDED.device_id,
              category = EXCLUDED.category, last_seen_at = EXCLUDED.last_seen_at,
              first_seen_at = CASE WHEN security_findings.status = 'open' THEN security_findings.first_seen_at ELSE EXCLUDED.first_seen_at END,
              acknowledged_at = CASE WHEN security_findings.status = 'open' THEN security_findings.acknowledged_at END,
              acknowledged_by = CASE WHEN security_findings.status = 'open' THEN security_findings.acknowledged_by END,
              status = 'open', resolved_at = NULL, resolution = NULL`,
      [organizationId, siteId, category, f.kind, f.key.slice(0, 200), f.severity, f.title.slice(0, 300), JSON.stringify(f.details), f.deviceId ?? null, now],
    );
  }
  const prefixes = opts.keyPrefixes ?? [''];
  for (const r of existing.rows) {
    if (r.status !== 'open' || seen.has(`${r.kind}\u0000${r.key}`)) continue;
    if (!prefixes.some((p) => r.key.startsWith(p))) continue;
    if (opts.kinds && !opts.kinds.includes(r.kind)) continue;
    await db.query(
      `UPDATE security_findings SET status = 'resolved', resolved_at = $5, resolution = $6
        WHERE organization_id = $1 AND site_id = $2 AND kind = $3 AND key = $4 AND status = 'open'`,
      [organizationId, siteId, r.kind, r.key, now, opts.resolution ?? 'No longer observed'],
    );
  }
  return opened;
}

/** Resolve one finding (e.g. after "this is expected"). */
export async function resolveFinding(db: Db, organizationId: string, siteId: string, kind: string, key: string, resolution: string, now = new Date()): Promise<boolean> {
  const r = await db.query(
    `UPDATE security_findings SET status = 'resolved', resolved_at = $5, resolution = $6
      WHERE organization_id = $1 AND site_id = $2 AND kind = $3 AND key = $4 AND status = 'open'`,
    [organizationId, siteId, kind, key, now, resolution],
  );
  return (r.rowCount ?? 0) > 0;
}
