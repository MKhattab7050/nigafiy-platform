import { defineModule } from '../../infrastructure/module.ts';
import { dispatchNotifications } from './dispatch.ts';
import { runEscalations } from './escalation.ts';
import { notificationsRouter } from './routes.ts';

/** Notification channels (webhook, email, Telegram, Slack, Discord, ntfy), delivery retries, and incident escalation. */
export const notificationsModule = defineModule({
  name: 'notifications',
  api: notificationsRouter,
  jobs: [
    { name: 'notification-dispatch', everyMs: 5_000, lockKey: 727102, run: dispatchNotifications },
    { name: 'notification-escalation', everyMs: 60_000, lockKey: 727106, run: async () => void (await runEscalations()) },
  ],
});

export { dispatchNotifications } from './dispatch.ts';
export { runEscalations } from './escalation.ts';
export { type NotificationEvent, type SmtpConfig, renderEmail } from './email.ts';
export { type NotificationChannelKind, renderDiscordPayload, renderNtfyMessage, renderSlackPayload, renderTelegramPayload } from './channels.ts';
export { type AccountMailOutcome, accountMailConfigured, anyAccountMailConfigured, sendAccountEmail } from './account-mail.ts';
