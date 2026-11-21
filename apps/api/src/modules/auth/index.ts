import { defineModule } from '../../infrastructure/module.ts';
import { authRouter } from './routes.ts';
import { teamRouter } from './team.ts';

/**
 * Identity & Team Accounts:
 *  - Public routes (/api/v1/auth): options, registration, sign-in/out, TOTP MFA verification &
 *    enrollment, password change & reset, public invitation preview & acceptance, current user &
 *    organization switching.
 *  - Session routes (/api/v1/team): members, invitations, admin-issued password resets, and
 *    organization MFA policy.
 */
export const authModule = defineModule({
  name: 'auth',
  publicApi: { path: '/auth', router: authRouter },
  api: teamRouter,
});

export { requireSession } from './session.ts';
