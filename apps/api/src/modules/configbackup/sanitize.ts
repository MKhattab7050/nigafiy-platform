import { createHmac } from 'node:crypto';

/**
 * Secret redaction for stored configurations.
 *
 * A device configuration carries passwords (often only weakly hashed or reversibly "encrypted":
 * Cisco type 7, Junos `$9$`, FortiOS `ENC`), SNMP communities, pre-shared keys, RADIUS/TACACS+ keys
 * and private keys. Before a configuration is stored, hashed, diffed or shown, every value
 * recognized by the rules below is replaced with a placeholder carrying a keyed fingerprint:
 *
 *     snmp-server community s3cr3t RO   →   snmp-server community <nigafiy-redacted:hmac=3f0a9c21b7d4> RO
 *
 * The fingerprint is HMAC-SHA-256 (truncated to 48 bits) of the value with a random key kept per
 * backup target (sealed at rest). The same secret gives the same placeholder in every version of that
 * device, so an unchanged configuration keeps its hash and a diff shows "this secret changed" without
 * revealing either value. Without the key a fingerprint cannot be brute-forced back into a weak
 * secret, and fingerprints of different devices cannot be compared.
 *
 * Rules err on the side of redacting: a word that is not a secret but sits where one would be (a
 * description mentioning "password x") is redacted too. Nothing is ever restored from the sanitized
 * text: a restore uses the separately sealed raw copy (see restore.ts).
 */

export const REDACTED_MARK = '<nigafiy-redacted:';
export const REDACTED_PREFIX = `${REDACTED_MARK}hmac=`;
const isPlaceholder = (value: string) => value.replace(/^["']/, '').startsWith('<nigafiy-redacted:');

export interface SanitizeResult {
  text: string;
  /** Values replaced, per rule id (counts only, never values). */
  redactions: Record<string, number>;
  total: number;
}

interface LineRule {
  id: string;
  /** Vendor family the rule was written for (for documentation and the redaction summary). */
  family: string;
  /** Global regex; group 1 = text kept before the value, group 2 = the secret value. */
  re: RegExp;
  /** Only applies inside this section (see sectionOf). */
  section?: RegExp;
}

// Value forms: a double- or single-quoted string, or a run of non-space characters (without Junos /
// PAN-OS statement terminators).
const Q = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'`;
const V = String.raw`(?:${Q}|[^\s;{}]+)`;
// Cisco-style "encryption type" tokens between a keyword and its value.
const CISCO_TYPE = String.raw`(?:(?:[0-9]|ENC|ciphertext|plaintext|encrypted|cleartext|sha256|sha512|irreversible-cipher|cipher|simple|hash|md5|0x)\s+)?`;

export const SANITIZE_RULES: readonly LineRule[] = [
  // ── Cisco IOS / IOS-XE / NX-OS / ASA, Aruba, Dell, Huawei VRP (same keyword-value shape) ──
  { id: 'enable_secret', family: 'cisco', re: new RegExp(String.raw`^(\s*enable\s+(?:secret|password)(?:\s+level\s+\d+)?\s+${CISCO_TYPE})(${V})`, 'g') },
  // username … secret|password [type] value ; ppp …password ; neighbor … password ; local-user … password cipher …
  { id: 'password_keyword', family: 'cisco', re: new RegExp(String.raw`(\b(?:password|secret|passwd)\s+${CISCO_TYPE})(?!level\b)(${V})`, 'g') },
  { id: 'snmp_community', family: 'cisco', re: new RegExp(String.raw`^(\s*snmp-server\s+community\s+)(${V})`, 'g') },
  // snmp-server host 10.0.0.5 [traps|informs] [version 1|2c|3 auth|noauth|priv] COMMUNITY …
  {
    id: 'snmp_host_community',
    family: 'cisco',
    re: new RegExp(String.raw`^(\s*snmp-server\s+host\s+\S+\s+(?:(?:traps|informs)\s+)?(?:version\s+(?:1|2c|3\s+(?:auth|noauth|priv))\s+)?)(?!version\b)(${V})`, 'g'),
  },
  // SNMPv3 users: auth sha X priv aes 128 Y (Cisco), auth md5 X (Aruba), authentication-password (Junos/VyOS handled below)
  { id: 'snmpv3_auth_priv', family: 'cisco', re: new RegExp(String.raw`(\b(?:auth\s+(?:md5|sha\S*)|priv\s+(?:des\S*|3des|aes(?:\s+\d+)?))\s+${CISCO_TYPE})(${V})`, 'g') },
  // Huawei: snmp-agent community read cipher %^%#…
  { id: 'huawei_snmp_community', family: 'huawei', re: new RegExp(String.raw`^(\s*snmp-agent\s+community\s+(?:read|write)\s+${CISCO_TYPE})(${V})`, 'g') },
  // RADIUS / TACACS+ global keys and "key 7 …" anywhere
  { id: 'aaa_server_key', family: 'cisco', re: new RegExp(String.raw`^(\s*(?:radius-server|tacacs-server|radius|tacacs)\b.*?\bkey\s+${CISCO_TYPE})(${V})`, 'g') },
  { id: 'typed_key', family: 'cisco', re: new RegExp(String.raw`((?<![\w-])key\s+[0-9]\s+)(${V})`, 'g') },
  // "key VALUE" inside a "radius server X" / "tacacs server X" / "aaa-server" block (indented)
  { id: 'aaa_block_key', family: 'cisco', re: new RegExp(String.raw`^(\s+key\s+${CISCO_TYPE})(${V})\s*$`, 'g'), section: /^(?:radius|tacacs)(?:-server|\s+server)\b|^aaa-server\b|^aaa\s+group\s+server\b/ },
  { id: 'key_string', family: 'cisco', re: new RegExp(String.raw`(\bkey-string\s+${CISCO_TYPE})(${V})`, 'g') },
  // IKE / IPsec pre-shared keys (IOS isakmp, IOS keyring, ASA tunnel-group, IKEv2 profiles)
  { id: 'isakmp_key', family: 'cisco', re: new RegExp(String.raw`^(\s*crypto\s+isakmp\s+key\s+${CISCO_TYPE})(${V})`, 'g') },
  { id: 'pre_shared_key', family: 'cisco', re: new RegExp(String.raw`(\bpre-shared-key\s+(?:address\s+\S+\s+(?:key\s+)?|local\s+|remote\s+|hostname\s+\S+\s+(?:key\s+)?)?${CISCO_TYPE})(?!ascii-text\b|hexadecimal\b)(${V})`, 'g') },
  { id: 'routing_auth_key', family: 'cisco', re: new RegExp(String.raw`(\b(?:authentication-key|message-digest-key\s+\d+\s+md5)\s+${CISCO_TYPE})(${V})`, 'g') },
  { id: 'hsrp_auth', family: 'cisco', re: new RegExp(String.raw`^(\s*standby\s+(?:\d+\s+)?authentication\s+(?:md5\s+key-string\s+|text\s+)?${CISCO_TYPE})(${V})`, 'g') },
  // Wireless (IOS autonomous / WLC style): wpa-psk ascii 0 VALUE
  { id: 'wpa_psk', family: 'cisco', re: new RegExp(String.raw`(\bwpa-psk\s+(?:ascii|hex)\s+${CISCO_TYPE})(${V})`, 'g') },
  // ASA: passwd VALUE encrypted
  { id: 'asa_passwd', family: 'cisco', re: new RegExp(String.raw`^(\s*passwd\s+)(${V})`, 'g') },

  // ── Juniper Junos (curly and "set" formats) / VyOS / EdgeOS ──
  {
    id: 'junos_vyos_secret',
    family: 'junos_vyos',
    re: new RegExp(
      String.raw`(\b(?:encrypted-password|plaintext-password|pre-shared-secret|secret|authentication-key|authentication-password|privacy-password|encryption-password|ascii-text|hexadecimal|hexadecimal-key|md5-key|passphrase|wpa-passphrase|private-key|preshared-key|psk)\s+${CISCO_TYPE})(?![\w-]+=[^=\s])(${V})`,
      'g',
    ),
  },
  // Junos "community NAME {" / "set snmp community NAME …", VyOS "community NAME {" / "set service snmp community NAME"
  { id: 'snmp_community_block', family: 'junos_vyos', re: new RegExp(String.raw`^(\s*(?:set\s+(?:service\s+)?snmp\s+)?community\s+)(${V})`, 'g') },
  // Junos marks every secret it knows: "…; ## SECRET-DATA". Any quoted value on such a line.
  { id: 'junos_secret_data', family: 'junos_vyos', re: new RegExp(String.raw`(\s)("\$\d+\$[^"]*"|"[^"]*")(?=[^"]*## SECRET-DATA)`, 'g') },
  // Junos $9$ obfuscation anywhere (reversible), quoted or not.
  { id: 'junos_dollar9', family: 'junos_vyos', re: /(["\s=])(\$9\$[^\s";]+)/g },

  // ── MikroTik RouterOS (/export terse: key=value) ──
  {
    id: 'routeros_secret',
    family: 'routeros',
    re: new RegExp(
      String.raw`(\s(?:password|secret|passphrase|wpa-pre-shared-key|wpa2-pre-shared-key|pre-shared-key|authentication-password|encryption-password|private-key|preshared-key|sae-password|radius-secret|shared-secret|key)=)(${V})`,
      'g',
    ),
  },
  // /snmp community … name=COMMUNITY (the community *is* its name)
  { id: 'routeros_snmp_community', family: 'routeros', re: new RegExp(String.raw`(\sname=)(${V})`, 'g'), section: /^\/snmp community\b/ },

  // ── Fortinet FortiOS ──
  // set password ENC xxx / set passwd ENC / set psksecret ENC / set sae-password / set auth-pwd / set priv-pwd / set key ENC / set secret ENC
  {
    id: 'fortios_set_secret',
    family: 'fortios',
    re: new RegExp(String.raw`^(\s*set\s+[\w-]*(?:password|passwd|psksecret|passphrase|secret|pwd|psk|key)\s+(?:ENC\s+)?)(${V})`, 'g'),
  },
  // config system snmp community / edit 1 / set name "public"
  { id: 'fortios_snmp_community', family: 'fortios', re: new RegExp(String.raw`^(\s*set\s+name\s+)(${V})`, 'g'), section: /^config system snmp community\b/ },

  // ── Palo Alto PAN-OS ("show config running": curly format; XML exports too) ──
  { id: 'panos_curly_secret', family: 'panos', re: new RegExp(String.raw`((?:^|[\s{])\s*(?:phash|password|key|private-key|secret|community|authpwd|privpwd|bind-password|passphrase|psk)\s+)(${V})(?=\s*;)`, 'g') },
  { id: 'panos_xml_secret', family: 'panos', re: /(<(phash|password|key|private-key|secret|community|authpwd|privpwd|bind-password|passphrase|psk)>)([^<]*)(?=<\/\2>)/g },

  // ── OpenWrt UCI (uci export: option NAME 'VALUE') ──
  {
    id: 'uci_secret',
    family: 'openwrt',
    re: new RegExp(
      String.raw`^(\s*option\s+(?:key|key[1-4]|password|passwd|private_key|preshared_key|auth_secret|acct_secret|dae_secret|sae_password|psk|secret|community|wpa_passphrase|ppp_password|pskpassword)\s+)(${V})`,
      'g',
    ),
  },
  { id: 'uci_list_secret', family: 'openwrt', re: new RegExp(String.raw`^(\s*list\s+(?:sae_password|key|password|preshared_key)\s+)(${V})`, 'g') },
];

const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/;
const PEM_END = /-----END ([A-Z0-9 ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/;

function fingerprint(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex').slice(0, 12);
}

/**
 * The section a line belongs to, for rules that only apply inside one:
 *  - RouterOS: the last "/menu path" line;
 *  - FortiOS: the innermost "config …" block (stack, closed by "end");
 *  - Cisco-style: the last non-indented line.
 */
class Sections {
  private routeros = '';
  private forti: string[] = [];
  private cisco = '';
  update(line: string): void {
    const t = line.trim();
    if (t.startsWith('/') && !line.startsWith(' ')) this.routeros = t;
    if (/^config\s+/.test(t)) this.forti.push(t);
    else if (t === 'end' && this.forti.length) this.forti.pop();
    if (line.length && !/^\s/.test(line)) this.cisco = t;
  }
  matches(re: RegExp): boolean {
    return re.test(this.routeros) || (this.forti.length > 0 && re.test(this.forti[this.forti.length - 1]!)) || re.test(this.cisco);
  }
}

/**
 * Replaces every recognized secret value with a keyed-fingerprint placeholder. Deterministic for a
 * given key, idempotent (placeholders are never redacted twice), and line-count preserving except
 * for private-key blocks, which become one line.
 */
export function sanitizeConfig(text: string, key: Buffer): SanitizeResult {
  const redactions: Record<string, number> = {};
  const count = (id: string) => {
    redactions[id] = (redactions[id] ?? 0) + 1;
  };
  const placeholder = (value: string) => {
    const quoted = /^(["']).*\1$/s.test(value) && value.length >= 2;
    const inner = quoted ? value.slice(1, -1) : value;
    const p = `${REDACTED_PREFIX}${fingerprint(key, inner)}>`;
    return quoted ? `${value[0]}${p}${value[0]}` : p;
  };

  const lines = text.split('\n');
  const out: string[] = [];
  const sections = new Sections();
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // Private-key blocks (PEM, OpenSSH, PGP) — possibly inside a quoted value (FortiOS, PAN-OS) —
    // become a single placeholder line keeping what surrounds the block.
    const begin = PEM_BEGIN.exec(line);
    if (begin) {
      let j = i;
      let endMatch: RegExpExecArray | null = PEM_END.exec(line.slice(begin.index));
      while (!endMatch && j + 1 < lines.length) {
        j++;
        endMatch = PEM_END.exec(lines[j]!);
      }
      if (endMatch) {
        const lastLine = j === i ? line.slice(begin.index) : lines[j]!;
        const endAt = lastLine.indexOf(endMatch[0]) + endMatch[0].length;
        const block = j === i ? line.slice(begin.index, begin.index + endAt) : [line.slice(begin.index), ...lines.slice(i + 1, j), lastLine.slice(0, endAt)].join('\n');
        const prefix = line.slice(0, begin.index);
        const suffix = lastLine.slice(endAt);
        out.push(`${prefix}<nigafiy-redacted:private-key-block:hmac=${fingerprint(key, block)}>${suffix}`);
        count('private_key_block');
        sections.update(prefix);
        i = j;
        continue;
      }
      // An unterminated block: redact the rest of the configuration rather than keep key material.
      out.push(`${line.slice(0, begin.index)}<nigafiy-redacted:private-key-block:hmac=${fingerprint(key, lines.slice(i).join('\n'))}>`);
      count('private_key_block');
      break;
    }

    sections.update(line);
    for (const rule of SANITIZE_RULES) {
      if (rule.section && !sections.matches(rule.section)) continue;
      rule.re.lastIndex = 0;
      if (!rule.re.test(line)) continue;
      rule.re.lastIndex = 0;
      if (rule.id === 'panos_xml_secret') {
        line = line.replace(rule.re, (m, open: string, _tag: string, value: string) => {
          if (!value || isPlaceholder(value)) return m;
          count(rule.id);
          return `${open}${placeholder(value)}`;
        });
        continue;
      }
      line = line.replace(rule.re, (m, before: string, value: string) => {
        if (!value || isPlaceholder(value)) return m;
        count(rule.id);
        return `${before}${placeholder(value)}`;
      });
    }
    out.push(line);
  }
  const total = Object.values(redactions).reduce((a, b) => a + b, 0);
  return { text: out.join('\n'), redactions, total };
}
