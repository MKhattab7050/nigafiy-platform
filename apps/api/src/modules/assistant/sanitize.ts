/**
 * What a lookup result may contain when it is sent to the model.
 *
 *  - Secrets are removed by key name (passwords, tokens, keys, SNMP communities, sealed values...).
 *    The read handlers never return credentials in the first place; this is a second guard.
 *  - Text that devices announce about themselves (hostnames, mDNS / SSDP / NetBIOS / DHCP names,
 *    event titles that embed them) or that people typed (names, notes, comments) is wrapped as
 *    <device_supplied>…</device_supplied>, with angle brackets inside replaced so it cannot close the
 *    tag. The system prompt tells the model this is data and never instructions (prompt-injection hygiene).
 *  - Long strings and long lists are cut, so one lookup cannot flood the conversation.
 */

const SECRET_KEY = /(^|_)(pass|passwd|password|passphrase|secret|secrets|token|tokens|credential|credentials|community|psk|cookie|cookies|sealed|session|sessions)($|_)|api_?key|private_?key|auth_?(key|pass)/i;

/** Fields whose strings are wrapped wherever they appear (and everything nested under them). */
const UNTRUSTED_KEYS = new Set([
  'hostname',
  'name',
  'display_name',
  'title',
  'subtitle',
  'label',
  'value',
  'body',
  'owner',
  'notes',
  'fingerprint',
  'type_evidence',
  'details',
  'sys_name',
  'attached_to',
  'resolution_note',
  'user_name',
  'assigned_to_name',
  'site_name',
  'evidence',
  'last_error',
  'error',
]);

const MAX_STRING = 400;
const MAX_ARRAY = 40;

export function untrusted(text: string): string {
  const clean = text
    .replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'))
    // control characters (other than tab / newline) carry nothing a reader needs
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .slice(0, MAX_STRING);
  return `<device_supplied>${clean}</device_supplied>`;
}

const cut = (s: string) => (s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s);

export function sanitize(value: unknown, wrap = false, depth = 0): unknown {
  if (depth > 8) return '[nested data omitted]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return wrap ? untrusted(value) : cut(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, wrap, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `… ${value.length - MAX_ARRAY} more not shown`] : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = sanitize(v, wrap || UNTRUSTED_KEYS.has(k), depth + 1);
    }
    return out;
  }
  return null;
}

/** Final size guard for one tool result (characters of JSON). */
export const MAX_TOOL_RESULT_CHARS = 14_000;

export function toToolContent(toolName: string, data: unknown): string {
  let json = JSON.stringify(sanitize(data));
  if (json.length > MAX_TOOL_RESULT_CHARS) json = `${json.slice(0, MAX_TOOL_RESULT_CHARS)} … [result truncated: ask a narrower question]`;
  return `<lan_detective_data tool="${toolName}">\n${json}\n</lan_detective_data>`;
}
