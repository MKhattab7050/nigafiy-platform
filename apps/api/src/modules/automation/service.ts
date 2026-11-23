import type { Request } from 'express';
import type { AutomationItem, AutomationList, AutomationOverride } from '@nigafiy/shared-types';
import { audit } from '../../common/audit.ts';
import { AppError, type AuthContext, notFound } from '../../common/http.ts';
import { type Db, withTenant } from '../../infrastructure/db.ts';
import { AUTOMATIONS, type AutomationKey, automationDefinition, defaultConfig } from './catalogue.ts';
import { type AutomationRow, EFFECT_WINDOW_DAYS, deleteSetting, lastEffects, loadRows, resolve, upsertSetting } from './repo.ts';

// Automation settings use cases. `req` is passed only for the audit trail.

const override = (r: AutomationRow | null): AutomationOverride | null =>
  r ? { enabled: r.enabled, config: r.config, updated_at: r.updated_at.toISOString(), updated_by: r.updated_by } : null;

async function assertSite(db: Db, siteId: string | null): Promise<void> {
  if (siteId && !(await db.query(`SELECT 1 FROM sites WHERE id = $1`, [siteId])).rowCount) throw notFound('Site');
}

async function buildItems(db: Db, organizationId: string, siteId: string | null, only?: AutomationKey): Promise<AutomationItem[]> {
  const rows = await loadRows(db, organizationId, siteId);
  const effects = await lastEffects(db, organizationId, siteId);
  return AUTOMATIONS.filter((a) => !only || a.key === only).map((a) => {
    const eff = resolve(a.key, rows, siteId);
    const e = effects.get(a.key);
    return {
      key: a.key,
      owner: a.owner,
      kind: a.kind,
      description_key: a.descriptionKey,
      description: a.description,
      default_enabled: a.defaultEnabled,
      enabled: eff.enabled,
      source: eff.source,
      config: eff.config,
      default_config: defaultConfig(a.key),
      org_override: override(eff.org),
      site_override: override(eff.site),
      last_effect: { count: e?.count ?? 0, last_at: e?.last_at ? e.last_at.toISOString() : null, window_days: EFFECT_WINDOW_DAYS },
    };
  });
}

export function listAutomations(organizationId: string, siteId: string | null): Promise<AutomationList> {
  return withTenant(organizationId, async (db) => {
    await assertSite(db, siteId);
    return { site_id: siteId, items: await buildItems(db, organizationId, siteId) };
  });
}

function knownKey(key: string): AutomationKey {
  if (!automationDefinition(key)) throw notFound('Automation');
  return key as AutomationKey;
}

export function setAutomation(
  req: Request,
  ctx: AuthContext,
  rawKey: string,
  body: { site_id?: string | null; enabled: boolean; config?: Record<string, unknown> },
): Promise<AutomationItem> {
  const key = knownKey(rawKey);
  let config: Record<string, unknown> | undefined;
  if (body.config !== undefined) {
    const parsed = automationDefinition(key)!.config.safeParse(body.config);
    if (!parsed.success) {
      throw new AppError(
        400,
        'validation_error',
        'The request is invalid',
        parsed.error.issues.slice(0, 20).map((i) => ({ path: ['config', ...i.path].join('.'), message: i.message })),
      );
    }
    // Store only what the user set; defaults stay in code so they can evolve.
    config = body.config;
  }
  const siteId = body.site_id ?? null;
  return withTenant(ctx.organizationId, async (db) => {
    await assertSite(db, siteId);
    await upsertSetting(db, ctx.organizationId, siteId, key, body.enabled, config, ctx.userId);
    await audit(db, req, 'automation.updated', { type: siteId ? 'site' : 'organization', id: siteId ?? ctx.organizationId }, {
      key,
      site_id: siteId,
      enabled: body.enabled,
      ...(config !== undefined ? { config } : {}),
    });
    return (await buildItems(db, ctx.organizationId, siteId, key))[0]!;
  });
}

/** Remove an override so the next level (organization, then catalogue default) applies again. */
export function resetAutomation(req: Request, ctx: AuthContext, rawKey: string, siteId: string | null): Promise<AutomationItem> {
  const key = knownKey(rawKey);
  return withTenant(ctx.organizationId, async (db) => {
    await assertSite(db, siteId);
    if (await deleteSetting(db, ctx.organizationId, siteId, key)) {
      await audit(db, req, 'automation.reset', { type: siteId ? 'site' : 'organization', id: siteId ?? ctx.organizationId }, { key, site_id: siteId });
    }
    return (await buildItems(db, ctx.organizationId, siteId, key))[0]!;
  });
}
