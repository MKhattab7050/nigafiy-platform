import type { Db } from '../../infrastructure/db.ts';
import { AUTOMATIONS, type AutomationKey, automationDefinition, defaultConfig } from './catalogue.ts';

// Every statement filters organization_id explicitly: these helpers are also called from platform
// (RLS-bypassing) transactions, e.g. incident correlation after a collector-watch sweep.

export type AutomationSource = 'default' | 'org' | 'site';

export interface AutomationRow {
  site_id: string | null;
  key: string;
  enabled: boolean;
  config: Record<string, unknown>;
  updated_by: string | null;
  updated_at: Date;
}

export interface EffectiveAutomation {
  enabled: boolean;
  source: AutomationSource;
  /** Catalogue default config, overlaid with the organization row's config, then the site row's. */
  config: Record<string, unknown>;
  org: AutomationRow | null;
  site: AutomationRow | null;
}

const ROW = `site_id, key, enabled, config, updated_by, updated_at`;

export async function loadRows(db: Db, organizationId: string, siteId: string | null, keys?: readonly string[]): Promise<AutomationRow[]> {
  return (
    await db.query<AutomationRow>(
      `SELECT ${ROW} FROM automation_settings
        WHERE organization_id = $1 AND (site_id IS NULL OR site_id = $2) AND ($3::text[] IS NULL OR key = ANY($3))`,
      [organizationId, siteId, keys ?? null],
    )
  ).rows;
}

export function resolve(key: AutomationKey, rows: readonly AutomationRow[], siteId: string | null): EffectiveAutomation {
  const def = automationDefinition(key)!;
  const org = rows.find((r) => r.key === key && r.site_id === null) ?? null;
  const site = siteId ? (rows.find((r) => r.key === key && r.site_id === siteId) ?? null) : null;
  const winner = site ?? org;
  return {
    enabled: winner ? winner.enabled : def.defaultEnabled,
    source: site ? 'site' : org ? 'org' : 'default',
    config: { ...defaultConfig(key), ...(org?.config ?? {}), ...(site?.config ?? {}) },
    org,
    site,
  };
}

/** Effective setting of one automation: site row overrides the organization row overrides the catalogue default. */
export async function automationSetting(db: Db, organizationId: string, siteId: string | null, key: AutomationKey): Promise<EffectiveAutomation> {
  return resolve(key, await loadRows(db, organizationId, siteId, [key]), siteId);
}

/** Whether `key` may act for this site now. Owning modules call this before every automatic action. */
export async function automationEnabled(db: Db, organizationId: string, siteId: string | null, key: AutomationKey): Promise<boolean> {
  return (await automationSetting(db, organizationId, siteId, key)).enabled;
}

/**
 * True when the automation already acted for this site within the last `minutes` (from its system
 * audit entries). Used as a rate limit so a flapping condition cannot make it act repeatedly.
 */
export async function actedRecently(db: Db, organizationId: string, key: AutomationKey, siteId: string, minutes: number): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM audit_logs
      WHERE organization_id = $1 AND actor <> 'user' AND metadata ->> 'automation' = $2 AND metadata ->> 'site_id' = $3
        AND created_at > now() - make_interval(mins => $4)
      LIMIT 1`,
    [organizationId, key, siteId, minutes],
  );
  return Boolean(r.rowCount);
}

export const EFFECT_WINDOW_DAYS = 30;

/** Count and newest time of each automation's system audit entries in the last 30 days (optionally for one site). */
export async function lastEffects(db: Db, organizationId: string, siteId: string | null): Promise<Map<string, { count: number; last_at: Date | null }>> {
  const rows = (
    await db.query<{ key: string; count: number; last_at: Date | null }>(
      `SELECT metadata ->> 'automation' AS key, count(*)::int AS count, max(created_at) AS last_at
         FROM audit_logs
        WHERE organization_id = $1 AND actor <> 'user' AND metadata ->> 'automation' = ANY($2)
          AND ($3::text IS NULL OR metadata ->> 'site_id' = $3)
          AND created_at > now() - make_interval(days => $4)
        GROUP BY 1`,
      [organizationId, AUTOMATIONS.map((a) => a.key), siteId, EFFECT_WINDOW_DAYS],
    )
  ).rows;
  return new Map(rows.map((r) => [r.key, { count: r.count, last_at: r.last_at }]));
}

export async function upsertSetting(
  db: Db,
  organizationId: string,
  siteId: string | null,
  key: AutomationKey,
  enabled: boolean,
  config: Record<string, unknown> | undefined,
  userId: string,
): Promise<void> {
  // config omitted = keep the stored one (or {} for a new row).
  const conflict = siteId ? `(organization_id, site_id, key) WHERE site_id IS NOT NULL` : `(organization_id, key) WHERE site_id IS NULL`;
  await db.query(
    `INSERT INTO automation_settings (organization_id, site_id, key, enabled, config, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,coalesce($5::jsonb, '{}'::jsonb),$6, now())
     ON CONFLICT ${conflict} DO UPDATE
       SET enabled = EXCLUDED.enabled, config = coalesce($5::jsonb, automation_settings.config), updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [organizationId, siteId, key, enabled, config === undefined ? null : JSON.stringify(config), userId],
  );
}

export async function deleteSetting(db: Db, organizationId: string, siteId: string | null, key: AutomationKey): Promise<boolean> {
  const r = await db.query(
    `DELETE FROM automation_settings WHERE organization_id = $1 AND key = $3 AND (CASE WHEN $2::uuid IS NULL THEN site_id IS NULL ELSE site_id = $2 END)`,
    [organizationId, siteId, key],
  );
  return Boolean(r.rowCount);
}
