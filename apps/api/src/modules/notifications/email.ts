import { lookup } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { isPublicAddress } from '../../common/net.ts';
import type { NotificationAction } from '@nigafiy/shared-types/notification-actions';
import { env } from '../../config/env.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  /** tls: encrypted from the first byte (usually 465). starttls: upgraded after connecting (587 / 25). none: plain text. */
  security: 'tls' | 'starttls' | 'none';
  username: string | null;
  from: string;
}

export interface NotificationEvent {
  id: string;
  type: string;
  severity: string;
  title: string;
  details: Record<string, unknown>;
  occurred_at: string;
  site_name?: string | null;
  device_id?: string | null;
  check_id?: string | null;
  /** Buttons for this delivery, with single-use tokens (item 9); absent when the event has none. */
  actions?: NotificationAction[];
}

const webBase = (base?: string): string => (base ?? (env.PUBLIC_URL || env.WEB_ORIGIN)).replace(/\/+$/, '');

/** The web page a button's link opens: it says what the button does and asks before acting (a link preview never acts). */
export function actionLandingUrl(token: string, base?: string): string {
  return `${webBase(base)}/notification-action/${encodeURIComponent(token)}`;
}

/** The API address that performs a button directly (ntfy's http action), through the web app's /api proxy. */
export function actionApiUrl(token: string, base?: string): string {
  return `${webBase(base)}/api/v1/notification-actions/${encodeURIComponent(token)}`;
}

/** The buttons that act (allow / pause) and carry a token. */
export const tokenActions = (event: Pick<NotificationEvent, 'actions'>): (NotificationAction & { token: string })[] =>
  (event.actions ?? []).filter((a): a is NotificationAction & { token: string } => typeof a.token === 'string' && a.token.length > 0);

/** The event details as shown in a message: `actions` (the buttons, kept in the event for the app) is not a detail. */
export const shownDetails = (details: Record<string, unknown>): [string, unknown][] => Object.entries(details).filter(([k]) => k !== 'actions');

/**
 * The page that shows an event (Milestone 4 URLs): the device card in Radar for a device event, the
 * monitoring page in Watch for a check event, otherwise Watch's event timeline. Base = the web app's
 * address (PUBLIC_URL, else WEB_ORIGIN), the same one invitation and reset e-mails use.
 */
export function eventPageUrl(event: Pick<NotificationEvent, 'device_id' | 'check_id' | 'type'>, base: string = env.PUBLIC_URL || env.WEB_ORIGIN): string {
  const root = base.replace(/\/+$/, '');
  const uuid = /^[0-9a-f-]{36}$/i;
  if (event.device_id && uuid.test(event.device_id)) return `${root}/radar/devices/${event.device_id}`;
  if (event.check_id && uuid.test(event.check_id)) return `${root}/watch/monitoring`;
  if (event.type === 'weekly_report') return `${root}/system/weekly`;
  return `${root}/watch/events?type=${encodeURIComponent(event.type)}`;
}

const TIMEOUT_MS = 10_000;

/** Header values must stay on one line: a newline would let event text add its own headers. */
const oneLine = (text: string): string => text.replace(/[\r\n\t]+/g, ' ').slice(0, 200);

function renderValue(value: unknown, indent: string): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.every((v) => typeof v !== 'object') ? value.join(', ') : value.map((v) => `\n${indent}  - ${renderValue(v, `${indent}    `)}`).join('');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `\n${indent}  ${k.replaceAll('_', ' ')}: ${renderValue(v, `${indent}  `)}`)
      .join('');
  }
  return String(value);
}

/** Plain text only: the body contains names announced by devices, which must never be interpreted as markup. */
export function renderEmail(event: NotificationEvent, organizationName: string): { subject: string; text: string } {
  const subject = oneLine(`[Nigafiy] ${event.severity.toUpperCase()}: ${event.title}`);
  const lines = [
    event.title,
    '',
    `Severity:  ${event.severity}`,
    `When:      ${new Date(event.occurred_at).toISOString()}`,
    `Where:     ${organizationName}${event.site_name ? ` / ${event.site_name}` : ''}`,
    `Event:     ${event.type}`,
    '',
    'What was observed:',
    ...shownDetails(event.details).map(([k, v]) => `  ${k.replaceAll('_', ' ')}: ${renderValue(v, '  ')}`),
    '',
    ...(tokenActions(event).length
      ? [
          'Act on it (each link works once, for 24 hours, and asks before it changes anything):',
          ...tokenActions(event).map((a) => `  ${a.label.en} / ${a.label.ar}: ${actionLandingUrl(a.token)}`),
          '',
        ]
      : []),
    `Open in Nigafiy: ${eventPageUrl(event)}`,
    '',
    'Sent by Nigafiy. Open the event timeline for the full context.',
  ];
  return { subject, text: lines.join('\n') };
}

export async function sendEmail(config: SmtpConfig, password: string | null, recipients: string[], message: { subject: string; text: string }): Promise<void> {
  // Resolve once and connect to exactly that address, as for webhooks.
  const addresses = await lookup(config.host, { all: true });
  const target = addresses[0];
  if (!target) throw new Error('mail server name did not resolve');
  if (!env.SMTP_ALLOW_PRIVATE_HOSTS && addresses.some((a) => !isPublicAddress(a.address))) {
    throw new Error('the mail server is on a private address; set SMTP_ALLOW_PRIVATE_HOSTS=true on the server to allow a mail relay on your own network');
  }
  const transport = nodemailer.createTransport({
    host: target.address,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    auth: config.username ? { user: config.username, pass: password ?? '' } : undefined,
    tls: { servername: config.host },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await transport.sendMail({ from: config.from, to: recipients, subject: message.subject, text: message.text });
  } finally {
    transport.close();
  }
}
