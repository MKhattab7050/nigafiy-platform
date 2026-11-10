import { lookup } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { isPublicAddress } from '../../common/net.ts';
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
  const subject = oneLine(`[LAN Detective] ${event.severity.toUpperCase()}: ${event.title}`);
  const lines = [
    event.title,
    '',
    `Severity:  ${event.severity}`,
    `When:      ${new Date(event.occurred_at).toISOString()}`,
    `Where:     ${organizationName}${event.site_name ? ` / ${event.site_name}` : ''}`,
    `Event:     ${event.type}`,
    '',
    'What was observed:',
    ...Object.entries(event.details).map(([k, v]) => `  ${k.replaceAll('_', ' ')}: ${renderValue(v, '  ')}`),
    '',
    'Sent by LAN Detective. Open the event timeline for the full context.',
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
