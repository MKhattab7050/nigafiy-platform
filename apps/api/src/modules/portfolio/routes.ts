import { Router } from 'express';
import type { PortfolioOrganizations, PortfolioSites } from '@lan-detective/shared-types';
import { auth } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { organizationRollup, siteRollup } from './service.ts';

/** Read-only roll-ups; every role with access may read them. */
export const portfolioRouter: Router = Router();

/** Every site of the current organization with its KPIs. */
portfolioRouter.get('/portfolio/sites', async (req, res) => {
  const ctx = auth(req);
  const items = await withTenant(ctx.organizationId, (db) => siteRollup(db, ctx.organizationId));
  const body: PortfolioSites = { organization_id: ctx.organizationId, generated_at: new Date().toISOString(), items };
  res.json(body);
});

/** The same KPIs per organization the signed-in user is an active member of (each read under its own tenant). */
portfolioRouter.get('/portfolio/organizations', async (req, res) => {
  const ctx = auth(req);
  const body: PortfolioOrganizations = { generated_at: new Date().toISOString(), items: await organizationRollup(ctx.userId, ctx.organizationId) };
  res.json(body);
});
