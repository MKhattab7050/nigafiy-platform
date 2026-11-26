import { Router } from 'express';
import { defineModule } from '../../infrastructure/module.ts';
import { dispatchNotifications } from './dispatch.ts';
import { runEscalations } from './escalation.ts';
import { heartbeatRouter, sendOutsideHeartbeats } from './heartbeat.ts';
import { notificationsRouter } from './routes.ts';
import { calmRouter } from './calm-routes.ts';
import { releaseCalmSummaries } from './policy.ts';
import { notificationActionsRouter } from './action-tokens.ts';
import { pollTelegramChannels, telegramRouter } from './telegram.ts';
import { webPushRouter } from './webpush-routes.ts';

const api: Router = Router();
api.use(notificationsRouter, heartbeatRouter, calmRouter);
api.use(webPushRouter);
api.use(telegramRouter); // Telegram by QR (item 10): link codes, linked chats

/**
 * Notification channels (webhook, email, Telegram, Slack, Discord, ntfy), delivery retries, incident
 * escalation, and the optional outside heartbeat (a push URL pinged while monitoring runs).
 */
export const notificationsModule = defineModule({
  name: 'notifications',
  api,
  // Buttons on notifications (Allow / Pause a new device): reached from Telegram, push and email, no session.
  publicApi: { path: '/notification-actions', router: notificationActionsRouter },
  jobs: [
    { name: 'notification-dispatch', everyMs: 5_000, lockKey: 727102, run: dispatchNotifications },
    { name: 'notification-escalation', everyMs: 60_000, lockKey: 727106, run: async () => void (await runEscalations()) },
    { name: 'outside-heartbeat', everyMs: 60_000, lockKey: 727182, run: sendOutsideHeartbeats },
    // Telegram by QR: reads each bot's updates ("/start <code>" links a chat, button presses act).
    { name: 'telegram-updates', everyMs: 4_000, lockKey: 727197, run: pollTelegramChannels },
    // Calm alerts: the quiet-hours summary when quiet hours end, the weekly summary when due.
    { name: 'notification-calm-summaries', everyMs: 60_000, lockKey: 727196, run: async () => void (await releaseCalmSummaries()) },
  ],
});

export { dispatchNotifications } from './dispatch.ts';
export { runEscalations } from './escalation.ts';
export { HEARTBEAT_INTERVAL_SECONDS, pingOnce, sendOutsideHeartbeats } from './heartbeat.ts';
export { type NotificationEvent, type SmtpConfig, renderEmail } from './email.ts';
export { type NotificationChannelKind, renderDiscordPayload, renderNtfyMessage, renderSlackPayload, renderTelegramPayload } from './channels.ts';
export { type AccountMailOutcome, accountMailConfigured, anyAccountMailConfigured, sendAccountEmail } from './account-mail.ts';
export {
  ACTION_TOKEN_HOURS,
  NOTIFICATION_PAUSE_MINUTES,
  actionLandingPath,
  deliveryActions,
  describeActionToken,
  issueActionTokens,
  newDeviceActions,
  redeemActionToken,
} from './action-tokens.ts';
export { applyDeliveryPolicy, decide, localParts, quietActive, releaseCalmSummaries, summaryDetails, summaryTitle, weeklyDue } from './policy.ts';
export { LINK_CODE_MINUTES, pollTelegramChannel, pollTelegramChannels, sendTelegramDelivery, telegramCall } from './telegram.ts';
