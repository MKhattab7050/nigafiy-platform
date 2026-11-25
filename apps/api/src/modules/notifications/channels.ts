import { type NotificationEvent, eventPageUrl } from './email.ts';

/**
 * Payload renderers for instant notification channels (Telegram, Slack, Discord, ntfy).
 * Device-supplied strings (hostnames, titles, details) are strictly escaped or passed as JSON
 * fields so untrusted LAN names can never inject markup or break formatting.
 */

export type NotificationChannelKind = 'webhook' | 'email' | 'telegram' | 'slack' | 'discord' | 'ntfy';

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  warning: '🟠',
  info: '🔵',
};

const SEVERITY_COLOR_HEX: Record<string, string> = {
  critical: '#e53e3e',
  warning: '#dd6b20',
  info: '#3182ce',
};

const SEVERITY_COLOR_INT: Record<string, number> = {
  critical: 0xe53e3e,
  warning: 0xdd6b20,
  info: 0x3182ce,
};

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * Slack mrkdwn control characters (https://api.slack.com/reference/surfaces/formatting#escaping):
 * without this a device named `<!channel>` or `<@U123>` pings people, and `<https://x|text>`
 * forges a link. EXT-6.
 */
export function escapeSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function summarizeDetails(details: Record<string, unknown>, maxLines = 6): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(details)) {
    if (v === null || v === undefined) continue;
    const label = k.replaceAll('_', ' ');
    let rendered: string;
    if (Array.isArray(v)) {
      rendered = v
        .slice(0, 4)
        .map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)))
        .join(', ');
    } else if (typeof v === 'object') {
      rendered = JSON.stringify(v);
    } else {
      rendered = String(v);
    }
    if (rendered.length > 140) rendered = `${rendered.slice(0, 137)}...`;
    lines.push(`${label}: ${rendered}`);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

/** Telegram Bot API sendMessage payload (HTML parse_mode, all dynamic text HTML-escaped). */
export function renderTelegramPayload(
  event: NotificationEvent,
  organizationName: string,
  chatId: string,
  threadId?: number,
  baseUrl?: string,
): Record<string, unknown> {
  const emoji = SEVERITY_EMOJI[event.severity] ?? 'ℹ️';
  const where = event.site_name ? `${organizationName} / ${event.site_name}` : organizationName;
  const link = eventPageUrl(event, baseUrl);
  const details = summarizeDetails(event.details);
  const parts = [
    `${emoji} <b>[${escapeHtml(event.severity.toUpperCase())}]</b> ${escapeHtml(event.title)}`,
    '',
    `<b>Where:</b> ${escapeHtml(where)}`,
    `<b>Event:</b> <code>${escapeHtml(event.type)}</code>`,
    `<b>When:</b> ${escapeHtml(new Date(event.occurred_at).toISOString())}`,
  ];
  if (details.length) {
    parts.push('', ...details.map((l) => `• ${escapeHtml(l)}`));
  }
  parts.push('', `<a href="${escapeHtml(link)}">Open in Nigafiy</a>`);
  return {
    chat_id: chatId,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: parts.join('\n').slice(0, 4000),
  };
}

/** Slack Incoming Webhook payload with color attachment + structured fields + link button. */
export function renderSlackPayload(event: NotificationEvent, organizationName: string, baseUrl?: string): Record<string, unknown> {
  const emoji = SEVERITY_EMOJI[event.severity] ?? 'ℹ️';
  const color = SEVERITY_COLOR_HEX[event.severity] ?? '#3182ce';
  const where = event.site_name ? `${organizationName} / ${event.site_name}` : organizationName;
  const link = eventPageUrl(event, baseUrl);
  const details = summarizeDetails(event.details);
  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *[${event.severity.toUpperCase()}]* ${escapeSlack(event.title)}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Where:*\n${escapeSlack(where)}` },
        { type: 'mrkdwn', text: `*Event:*\n\`${event.type}\`` },
      ],
    },
  ];
  if (details.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: details.map((l) => `• ${escapeSlack(l)}`).join('\n').slice(0, 2800) },
    });
  }
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open in Nigafiy' },
        url: link,
      },
    ],
  });
  return {
    text: `[Nigafiy ${event.severity.toUpperCase()}] ${escapeSlack(event.title)}`,
    attachments: [{ color, blocks }],
  };
}

/** Discord Webhook payload with rich embed. */
export function renderDiscordPayload(event: NotificationEvent, organizationName: string, baseUrl?: string): Record<string, unknown> {
  const color = SEVERITY_COLOR_INT[event.severity] ?? 0x3182ce;
  const where = event.site_name ? `${organizationName} / ${event.site_name}` : organizationName;
  const link = eventPageUrl(event, baseUrl);
  const details = summarizeDetails(event.details);
  return {
    username: 'Nigafiy',
    // Device-supplied text (names, titles) never pings anyone: @everyone, <@id> and <@&role> stay text. EXT-6.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `[${event.severity.toUpperCase()}] ${event.title}`.slice(0, 256),
        url: link,
        color,
        description: details.length ? details.map((l) => `• ${l}`).join('\n').slice(0, 2000) : undefined,
        fields: [
          { name: 'Where', value: where.slice(0, 1000), inline: true },
          { name: 'Event', value: `\`${event.type}\``, inline: true },
        ],
        timestamp: new Date(event.occurred_at).toISOString(),
        footer: { text: 'Nigafiy Network Operations' },
      },
    ],
  };
}

/** ntfy push notification request (plain text body + X-Title / X-Priority / X-Tags / X-Click). */
export function renderNtfyMessage(
  event: NotificationEvent,
  organizationName: string,
  baseUrl?: string,
): { body: string; headers: Record<string, string> } {
  const where = event.site_name ? `${organizationName} / ${event.site_name}` : organizationName;
  const link = eventPageUrl(event, baseUrl);
  const details = summarizeDetails(event.details);
  const priority = event.severity === 'critical' ? '5' : event.severity === 'warning' ? '4' : '3';
  const tags = event.severity === 'critical' ? 'rotating_light' : event.severity === 'warning' ? 'warning' : 'information_source';
  // HTTP headers must be ASCII single-line; keep full UTF-8 title inside the body as well.
  const asciiTitle = `[Nigafiy ${event.severity.toUpperCase()}] ${event.title}`
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const lines = [event.title, `Where: ${where}`, `Event: ${event.type}`];
  if (details.length) lines.push('', ...details);
  return {
    body: lines.join('\n').slice(0, 3800),
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Title': asciiTitle || 'Nigafiy Alert',
      'X-Priority': priority,
      'X-Tags': tags,
      'X-Click': link,
    },
  };
}
