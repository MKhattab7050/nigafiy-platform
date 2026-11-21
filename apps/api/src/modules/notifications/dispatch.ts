import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { decryptSecret, hmacSha256 } from '../../common/crypto.ts';
import { isPublicAddress } from '../../common/net.ts';
import { env } from '../../config/env.ts';
import { systemPool } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import {
  type NotificationChannelKind,
  renderDiscordPayload,
  renderNtfyMessage,
  renderSlackPayload,
  renderTelegramPayload,
} from './channels.ts';
import { type NotificationEvent, type SmtpConfig, renderEmail, sendEmail } from './email.ts';

const MAX_ATTEMPTS = 6;
const LEASE_SECONDS = 120;
const TIMEOUT_MS = 8000;

interface ChannelConfig extends SmtpConfig {
  chat_id?: string;
  message_thread_id?: number;
  api_base?: string;
  server_url?: string;
  topic?: string;
}

interface DueDelivery {
  id: string;
  attempts: number;
  kind: NotificationChannelKind;
  url: string;
  config: ChannelConfig;
  secret_encrypted: string;
  organization_id: string;
  organization_name: string;
  event: Record<string, unknown>;
}

/**
 * POST to an external destination with SSRF mitigations:
 *  - resolve the host ourselves and refuse non-public addresses (unless ALLOW_PRIVATE_WEBHOOKS),
 *  - connect to exactly the address we vetted (pinned lookup → no DNS-rebinding window),
 *  - never follow redirects, short timeout, response body discarded.
 */
async function post(rawUrl: string, body: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(rawUrl);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  const target = addresses[0];
  if (!target) throw new Error('host did not resolve');
  if (!env.ALLOW_PRIVATE_WEBHOOKS && addresses.some((a) => !isPublicAddress(a.address))) {
    throw new Error('destination resolves to a non-public address');
  }
  const pinned = (_host: string, options: { all?: boolean }, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) =>
    options.all ? cb(null, [target]) : cb(null, target.address, target.family);

  return new Promise<number>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'POST', headers, timeout: TIMEOUT_MS, lookup: pinned as never }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function sanitizeError(err: unknown, secrets: string[]): string {
  let msg = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, ' ');
  for (const s of secrets) {
    if (s && s.length >= 6) msg = msg.replaceAll(s, '[redacted]');
  }
  return msg.slice(0, 200);
}

export async function dispatchNotifications(): Promise<void> {
  // Claim a batch with a lease so the HTTP/SMTP calls happen outside any transaction.
  const due = await systemPool.query<DueDelivery>(
    `WITH claimed AS (
       SELECT id FROM notification_deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED
     )
     UPDATE notification_deliveries d
        SET attempts = d.attempts + 1, next_attempt_at = now() + make_interval(secs => $1)
       FROM claimed, notification_channels c, network_events e, organizations o
      WHERE d.id = claimed.id AND c.id = d.channel_id AND e.id = d.event_id AND o.id = d.organization_id
     RETURNING d.id, d.attempts, d.organization_id, o.name AS organization_name, c.kind, c.url, c.config, c.secret_encrypted,
               jsonb_build_object('id', e.id, 'type', e.type, 'severity', e.severity, 'title', e.title, 'details', e.details,
                                  'site_id', e.site_id, 'device_id', e.device_id, 'check_id', e.check_id,
                                  'occurred_at', e.occurred_at,
                                  'site_name', (SELECT s.name FROM sites s WHERE s.id = e.site_id)) AS event`,
    [LEASE_SECONDS],
  );

  await Promise.all(
    due.rows.map(async (d) => {
      const ev = d.event as unknown as NotificationEvent;
      let error: string | null = null;
      const secretsToRedact: string[] = [];

      try {
        if (d.kind === 'email') {
          const secret = JSON.parse(decryptSecret(d.secret_encrypted)) as { password?: string };
          if (secret.password) secretsToRedact.push(secret.password);
          const recipients = d.url.replace(/^mailto:/, '').split(',');
          await sendEmail(d.config, secret.password ?? null, recipients, renderEmail(ev, d.organization_name));
        } else if (d.kind === 'telegram') {
          const secret = JSON.parse(decryptSecret(d.secret_encrypted)) as { bot_token: string };
          secretsToRedact.push(secret.bot_token);
          const base = (d.config.api_base || 'https://api.telegram.org').replace(/\/+$/, '');
          const payload = JSON.stringify(renderTelegramPayload(ev, d.organization_name, d.config.chat_id ?? '', d.config.message_thread_id));
          const status = await post(`${base}/bot${secret.bot_token}/sendMessage`, payload, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
            'User-Agent': 'Nigafiy-Notifications/1',
          });
          if (status < 200 || status >= 300) error = `Telegram responded with HTTP ${status}`;
        } else if (d.kind === 'slack') {
          const secret = JSON.parse(decryptSecret(d.secret_encrypted)) as { webhook_url: string };
          secretsToRedact.push(secret.webhook_url);
          const payload = JSON.stringify(renderSlackPayload(ev, d.organization_name));
          const status = await post(secret.webhook_url, payload, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
            'User-Agent': 'Nigafiy-Notifications/1',
          });
          if (status < 200 || status >= 300) error = `Slack responded with HTTP ${status}`;
        } else if (d.kind === 'discord') {
          const secret = JSON.parse(decryptSecret(d.secret_encrypted)) as { webhook_url: string };
          secretsToRedact.push(secret.webhook_url);
          const payload = JSON.stringify(renderDiscordPayload(ev, d.organization_name));
          const status = await post(secret.webhook_url, payload, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
            'User-Agent': 'Nigafiy-Notifications/1',
          });
          if (status < 200 || status >= 300) error = `Discord responded with HTTP ${status}`;
        } else if (d.kind === 'ntfy') {
          const secret = JSON.parse(decryptSecret(d.secret_encrypted)) as { token?: string; password?: string };
          if (secret.token) secretsToRedact.push(secret.token);
          if (secret.password) secretsToRedact.push(secret.password);
          const base = (d.config.server_url || 'https://ntfy.sh').replace(/\/+$/, '');
          const topic = d.config.topic ?? '';
          const msg = renderNtfyMessage(ev, d.organization_name);
          const headers: Record<string, string> = {
            ...msg.headers,
            'Content-Length': String(Buffer.byteLength(msg.body)),
            'User-Agent': 'Nigafiy-Notifications/1',
          };
          if (secret.token) {
            headers.Authorization = `Bearer ${secret.token}`;
          } else if (d.config.username && secret.password) {
            headers.Authorization = `Basic ${Buffer.from(`${d.config.username}:${secret.password}`).toString('base64')}`;
          }
          const status = await post(`${base}/${encodeURIComponent(topic)}`, msg.body, headers);
          if (status < 200 || status >= 300) error = `ntfy responded with HTTP ${status}`;
        } else {
          const timestamp = Math.floor(Date.now() / 1000);
          const body = JSON.stringify({ delivery_id: d.id, organization_id: d.organization_id, sent_at: new Date().toISOString(), event: d.event });
          const signingKey = decryptSecret(d.secret_encrypted);
          secretsToRedact.push(signingKey);
          const signature = hmacSha256(signingKey, `${timestamp}.${body}`);
          const status = await post(d.url, body, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            'User-Agent': 'LAN-Detective-Webhook/1',
            'X-LAN-Detective-Signature': `t=${timestamp},v1=${signature}`,
          });
          if (status < 200 || status >= 300) error = `receiver responded with HTTP ${status}`;
        }
      } catch (err) {
        error = sanitizeError(err, secretsToRedact);
      }

      if (!error) {
        await systemPool.query(`UPDATE notification_deliveries SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = $1`, [d.id]);
        return;
      }
      const exhausted = d.attempts >= MAX_ATTEMPTS;
      // Exponential backoff: 30 s, 1 min, 2 min … capped at 1 h.
      const delaySeconds = Math.min(3600, 30 * 2 ** (d.attempts - 1));
      await systemPool.query(
        `UPDATE notification_deliveries SET status = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
        [d.id, exhausted ? 'failed' : 'pending', error, delaySeconds],
      );
      logger.warn({ delivery_id: d.id, kind: d.kind, attempt: d.attempts, error, exhausted }, 'notification delivery failed');
    }),
  );
}
