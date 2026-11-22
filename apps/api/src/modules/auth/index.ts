import { Router } from 'express';
import { defineModule } from '../../infrastructure/module.ts';
import { authRouter } from './routes.ts';
import { ssoAdminRouter } from './sso/admin.ts';
import { cleanupSso } from './sso/routes.ts';
import { teamRouter } from './team.ts';

/**
 * Identity & Team Accounts:
 *  - Public routes (/api/v1/auth): options, registration, sign-in/out, TOTP MFA verification &
 *    enrollment, password change & reset, public invitation preview & acceptance, current user &
 *    organization switching.
 *  - Session routes (/api/v1/team): members, invitations, admin-issued password resets, and
 *    organization MFA policy; organization identity providers for SSO (/api/v1/sso/providers).
 *  - Enterprise SSO (/api/v1/auth/sso): OIDC and SAML 2.0 sign-in, see docs/features/sso.md.
 */
const api: Router = Router();
api.use(teamRouter);
api.use(ssoAdminRouter);

export const authModule = defineModule({
  name: 'auth',
  publicApi: { path: '/auth', router: authRouter },
  api,
  jobs: [{ name: 'sso-cleanup', everyMs: 3600_000, lockKey: 727142, run: cleanupSso }],
});

export { readCookie, requireSession, resolveSessionToken, SESSION_COOKIE } from './session.ts';
