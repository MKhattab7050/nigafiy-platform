import { defineModule } from '../../infrastructure/module.ts';
import { portfolioRouter } from './routes.ts';

/**
 * Multi-site / MSP portfolio: GET /portfolio/sites (sites of the current organization) and
 * GET /portfolio/organizations (every organization the user is an active member of, each queried
 * inside its own tenant context). Health scores reuse the insights rules.
 */
export const portfolioModule = defineModule({ name: 'portfolio', api: portfolioRouter });
