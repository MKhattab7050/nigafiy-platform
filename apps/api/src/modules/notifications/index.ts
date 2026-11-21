import { defineModule } from '../../infrastructure/module.ts';
import { dispatchNotifications } from './dispatch.ts';
import { notificationsRouter } from './routes.ts';

/** Notification channels (webhook, email) and the delivery job with retries and back-off. */
export const notificationsModule = defineModule({
  name: 'notifications',
  api: notificationsRouter,
  jobs: [{ name: 'notification-dispatch', everyMs: 5_000, lockKey: 727102, run: dispatchNotifications }],
});

export { dispatchNotifications } from './dispatch.ts';
export { type NotificationEvent, type SmtpConfig, renderEmail } from './email.ts';
export { type AccountMailOutcome, accountMailConfigured, anyAccountMailConfigured, sendAccountEmail } from './account-mail.ts';
