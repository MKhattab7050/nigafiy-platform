import { decryptSecret } from '../../common/crypto.ts';
import { systemPool } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { type SmtpConfig, sendEmail } from './email.ts';

/**
 * Account mail (invitations, password resets) goes only through an email channel an administrator
 * explicitly marked "use for account emails" — never through an alert channel by default. An
 * on-premise install without such a channel simply has no system mail: the API then hands the
 * one-time link to the administrator instead.
 */

export type AccountMailOutcome = 'sent' | 'not_configured' | 'failed';

interface AccountChannel {
  id: string;
  config: SmtpConfig;
  secret_encrypted: string;
}

async function accountChannel(organizationId: string): Promise<AccountChannel | undefined> {
  const { rows } = await systemPool.query<AccountChannel>(
    `SELECT id, config, secret_encrypted FROM notification_channels
      WHERE organization_id = $1 AND kind = 'email' AND enabled AND use_for_account_emails
      ORDER BY created_at LIMIT 1`,
    [organizationId],
  );
  return rows[0];
}

export async function accountMailConfigured(organizationId: string): Promise<boolean> {
  return Boolean(await accountChannel(organizationId));
}

/** Whether any organization of this installation can send account mail (the sign-in page offers "forgot password" then). */
export async function anyAccountMailConfigured(): Promise<boolean> {
  const { rowCount } = await systemPool.query(`SELECT 1 FROM notification_channels WHERE kind = 'email' AND enabled AND use_for_account_emails LIMIT 1`);
  return Boolean(rowCount);
}

/** Send one plain-text account email. Never throws; the outcome says what happened (the reason is logged, without the message). */
export async function sendAccountEmail(organizationId: string, to: string, message: { subject: string; text: string }): Promise<AccountMailOutcome> {
  const channel = await accountChannel(organizationId);
  if (!channel) return 'not_configured';
  try {
    const secret = JSON.parse(decryptSecret(channel.secret_encrypted)) as { password?: string };
    await sendEmail(channel.config, secret.password ?? null, [to], { subject: message.subject.replace(/[\r\n\t]+/g, ' ').slice(0, 200), text: message.text });
    return 'sent';
  } catch (err) {
    logger.warn({ channel_id: channel.id, error: (err as Error).message.replace(/[\r\n]+/g, ' ').slice(0, 200) }, 'account email failed');
    return 'failed';
  }
}
