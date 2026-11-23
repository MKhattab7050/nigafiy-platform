import type { Confidence, DeviceType } from '@nigafiy/shared-types';

/**
 * DHCP fingerprinting — deterministic rules, first match wins.
 *
 * Every DHCP client asks for a list of options (option 55, the "parameter request list") and many
 * send a vendor class (option 60). Both are set by the operating system's DHCP client, not by the
 * user, so their shape identifies the OS family. The rules below match well-known, stable shapes;
 * anything else stays unclassified. Modern Apple systems (iOS, iPadOS, macOS) send the same list,
 * so they are reported together unless another clue separates them.
 */

export type OsFamily = 'windows' | 'android' | 'apple' | 'macos' | 'linux' | 'chromeos' | 'embedded_linux' | 'printer' | 'voip_phone' | 'game_console';

export interface DhcpOsResult {
  os_family: OsFamily;
  label: string;
  confidence: Confidence;
  /** The device type this implies in the inventory, or null when the OS does not settle it. */
  device_type: DeviceType | null;
  evidence: string;
}

const LABEL: Record<OsFamily, string> = {
  windows: 'Windows',
  android: 'Android',
  apple: 'Apple iOS, iPadOS or macOS',
  macos: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  embedded_linux: 'Embedded Linux (busybox)',
  printer: 'Network printer',
  voip_phone: 'VoIP phone',
  game_console: 'Game console',
};

export const osFamilyLabel = (f: OsFamily) => LABEL[f];

export function parsePrl(prl: string): number[] {
  return prl
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

const startsWith = (list: number[], prefix: number[]) => prefix.every((v, i) => list[i] === v);

export function classifyDhcp(prl: string, vendorClass: string | null | undefined): DhcpOsResult | null {
  const list = parsePrl(prl);
  const vc = (vendorClass ?? '').trim();
  const has = (...codes: number[]) => codes.every((c) => list.includes(c));
  const out = (os_family: OsFamily, confidence: Confidence, device_type: DeviceType | null, why: string): DhcpOsResult => ({
    os_family,
    label: LABEL[os_family],
    confidence,
    device_type,
    evidence: `DHCP fingerprint looks like ${LABEL[os_family]}: ${why}`,
  });
  const prlText = list.length ? `requests options ${list.join(',')}` : 'no option list';

  // ── vendor class first: explicit product strings ──
  if (/xbox/i.test(vc)) return out('game_console', 'high', 'media_player', `vendor class "${vc}"`);
  if (/playstation|sony.?interactive|\bps[345]\b/i.test(vc)) return out('game_console', 'high', 'media_player', `vendor class "${vc}"`);
  if (/nintendo/i.test(vc)) return out('game_console', 'high', 'media_player', `vendor class "${vc}"`);
  if (/ip ?phone|polycom|yealink|grandstream|avaya|snom|mitel|aastra|cisco systems.*phone|\bcp-\d{4}/i.test(vc)) return out('voip_phone', 'high', 'iot', `vendor class "${vc}"`);
  if (/jetdirect|printer|brother|canon|epson|lexmark|ricoh|kyocera|xerox|konica|sharp|oki data/i.test(vc)) return out('printer', 'high', 'printer', `vendor class "${vc}"`);
  if (/^android-dhcp/i.test(vc)) return out('android', 'high', 'mobile', `vendor class "${vc}"`);
  if (/dhcpcd/i.test(vc) && /chrom|cros/i.test(vc)) return out('chromeos', 'high', 'linux_computer', `vendor class "${vc}"`);
  if (/^MSFT 5\.0/i.test(vc)) return out('windows', has(249, 252) || has(43, 44, 46, 47) ? 'high' : 'medium', 'windows_computer', `vendor class "${vc}", ${prlText}`);
  if (/^udhcp/i.test(vc)) return out('embedded_linux', 'medium', null, `vendor class "${vc}"`);
  if (/dhcpcd/i.test(vc)) return out('linux', 'medium', 'linux_computer', `vendor class "${vc}"`);

  if (!list.length) return null;

  // ── option-list shapes ──
  // Windows: NetBIOS options 43/44/46/47 plus the Microsoft classless-route option 249 and WPAD 252.
  if (has(1, 3, 6, 15, 31, 33, 43, 44, 46, 47, 121, 249, 252)) return out('windows', 'high', 'windows_computer', prlText);
  if (has(1, 3, 6, 15, 44, 46, 47, 249)) return out('windows', 'medium', 'windows_computer', prlText);
  // Apple: classless routes (121) asked second, right after the subnet mask.
  if (startsWith(list, [1, 121, 3, 6, 15])) {
    if (list.includes(101)) return out('macos', 'medium', 'apple_computer', `${prlText} (includes option 101, sent by macOS)`);
    return out('apple', 'medium', null, prlText);
  }
  // Android (since 2017): subnet, router, DNS, domain, MTU, broadcast, lease, T1, T2.
  if (startsWith(list, [1, 3, 6, 15, 26, 28, 51, 58, 59])) return out('android', 'high', 'mobile', prlText);
  // ISC dhclient (most Linux distributions).
  if (startsWith(list, [1, 28, 2, 3, 15, 6])) return out('linux', 'high', 'linux_computer', prlText);
  // NetworkManager's internal client / systemd-networkd.
  if (startsWith(list, [1, 2, 6, 12, 15, 26, 28, 121, 3, 33, 40, 41, 42])) return out('linux', 'medium', 'linux_computer', prlText);
  // VoIP phones ask for the TFTP provisioning server (66, 150).
  if (has(66) && has(150)) return out('voip_phone', 'medium', 'iot', `${prlText} (asks for TFTP provisioning servers 66 and 150)`);
  // HP printers ask for option 144 (HP proprietary).
  if (has(144) && has(44)) return out('printer', 'medium', 'printer', `${prlText} (includes HP option 144)`);
  // busybox udhcpc: a short list ending at NTP.
  if (list.join(',') === '1,3,6,12,15,28,42') return out('embedded_linux', 'low', null, prlText);
  // PlayStation 4/5.
  if (list.join(',') === '1,3,15,6') return out('game_console', 'low', 'media_player', `${prlText} (the list PlayStation consoles send)`);
  return null;
}
