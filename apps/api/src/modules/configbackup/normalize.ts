import { sha256 } from '../../common/crypto.ts';

/**
 * Lines a device rewrites without any configuration change (timestamps, byte counts, clock drift
 * values). They are removed before storing and hashing, so an unchanged device produces the same
 * hash every day and a diff shows only real changes. Every pattern is anchored to a whole line.
 */
export const VOLATILE_LINES: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /^! Last configuration change at .*$/, why: 'Cisco IOS / Dell: time of the last change' },
  { pattern: /^! NVRAM config last updated at .*$/, why: 'Cisco IOS: time of the last save' },
  { pattern: /^! No configuration change since last restart\s*$/, why: 'Cisco IOS: restart marker' },
  { pattern: /^ntp clock-period \d+\s*$/, why: 'Cisco IOS: measured clock drift' },
  { pattern: /^Building configuration\.\.\.\s*$/, why: 'Cisco IOS: command banner' },
  { pattern: /^Current configuration ?: ?\d+ bytes\s*$/, why: 'Cisco IOS: configuration size' },
  { pattern: /^!Time: .*$/, why: 'Cisco NX-OS: time the command ran' },
  { pattern: /^!Running configuration last done at: .*$/, why: 'Cisco NX-OS: time of the last change' },
  { pattern: /^Cryptochecksum:[0-9a-f ]+$/i, why: 'Cisco ASA: checksum over the configuration and its timestamps' },
  { pattern: /^## Last (commit|changed): .*$/, why: 'Juniper Junos: commit time' },
  { pattern: /^# \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} by RouterOS .*$/, why: 'MikroTik RouterOS 7: export time' },
  { pattern: /^# [a-z]{3}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} by RouterOS .*$/, why: 'MikroTik RouterOS 6: export time' },
  { pattern: /^#conf_file_ver=\d+\s*$/, why: 'Fortinet FortiOS: revision counter' },
  { pattern: /^!Last configuration was (updated|saved) at .*$/, why: 'Huawei VRP: time of the last change' },
];

export interface NormalizedConfig {
  text: string;
  sha256: string;
  sizeBytes: number;
  lineCount: number;
  removedVolatile: number;
}

/** Plain text with LF line ends, no trailing spaces, no volatile lines, no leading/trailing blank lines. */
export function normalizeConfig(raw: string): NormalizedConfig {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let removedVolatile = 0;
  for (const line of lines) {
    const l = line.replace(/[ \t]+$/, '');
    if (VOLATILE_LINES.some((v) => v.pattern.test(l))) {
      removedVolatile++;
      continue;
    }
    kept.push(l);
  }
  while (kept.length && kept[0]!.trim() === '') kept.shift();
  while (kept.length && kept[kept.length - 1]!.trim() === '') kept.pop();
  const text = kept.length ? `${kept.join('\n')}\n` : '';
  return { text, sha256: sha256(text), sizeBytes: Buffer.byteLength(text, 'utf8'), lineCount: kept.length, removedVolatile };
}
