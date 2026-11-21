/**
 * Vendor suggestion from what LAN Detective already knows about a device, BEFORE any login: the SSH
 * identification line (reachability check), the SNMP sysDescr (Port Detective) and the IEEE OUI
 * vendor of its MAC. It mirrors the collector's own signatures (internal/configbackup/drivers.go,
 * detect.go) with the same weights. It is only a suggestion ("inferred"): the collector detects the
 * vendor again on every backup from the device's own prompt and answers.
 */

interface Signature {
  driver: string;
  sysDescr?: RegExp;
  oui?: RegExp;
}

const SIGNATURES: Signature[] = [
  { driver: 'cisco_ios', sysDescr: /Cisco IOS|IOS-XE/, oui: /\bcisco\b/i },
  { driver: 'cisco_nxos', sysDescr: /NX-OS|Nexus/, oui: /\bcisco\b/i },
  { driver: 'cisco_asa', sysDescr: /Adaptive Security Appliance/, oui: /\bcisco\b/i },
  { driver: 'aruba_procurve', sysDescr: /ProCurve|ArubaOS-Switch|HP J\d{4}|Aruba J[A-Z]?\d{3,4}/, oui: /hewlett|\bhp\b|aruba|procurve/i },
  { driver: 'aruba_aoscx', sysDescr: /ArubaOS-CX|AOS-CX/, oui: /hewlett|aruba/i },
  { driver: 'juniper_junos', sysDescr: /JUNOS|Juniper/, oui: /juniper/i },
  { driver: 'mikrotik_routeros', sysDescr: /RouterOS/, oui: /routerboard|mikrotik/i },
  { driver: 'fortinet_fortios', sysDescr: /FortiGate|FortiOS/, oui: /fortinet/i },
  { driver: 'vyos_edgeos', sysDescr: /EdgeOS|EdgeRouter|VyOS|Vyatta/, oui: /ubiquiti/i },
  { driver: 'huawei_vrp', sysDescr: /Huawei|VRP/, oui: /huawei/i },
  { driver: 'dell_os10', sysDescr: /OS10/, oui: /\bdell\b/i },
  { driver: 'dell_os6', sysDescr: /Dell (EMC )?Networking N\d|PowerConnect/, oui: /\bdell\b/i },
  { driver: 'openwrt', sysDescr: /OpenWrt/ },
  { driver: 'paloalto_panos', sysDescr: /Palo Alto Networks|PAN-OS/, oui: /palo alto/i },
];

const VERSION_HINTS: { re: RegExp; drivers: string[]; weight: number }[] = [
  { re: /^SSH-[\d.]+-ROSSSH/i, drivers: ['mikrotik_routeros'], weight: 80 },
  { re: /^SSH-[\d.]+-HUAWEI/i, drivers: ['huawei_vrp'], weight: 80 },
  { re: /^SSH-[\d.]+-Cisco-/i, drivers: ['cisco_ios', 'cisco_asa'], weight: 40 },
];

const W_SYSDESCR = 30;
const W_OUI = 15;

export interface DriverEvidence {
  source: 'server_version' | 'sys_descr' | 'oui_vendor';
  driver: string;
  detail: string;
  weight: number;
}

export interface DriverSuggestion {
  driver: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  evidence: DriverEvidence[];
}

export function suggestDriver(input: { serverVersion?: string | null; sysDescr?: string | null; ouiVendor?: string | null }): DriverSuggestion {
  const evidence: DriverEvidence[] = [];
  const clip = (s: string) => s.slice(0, 200);
  if (input.serverVersion) {
    for (const h of VERSION_HINTS) if (h.re.test(input.serverVersion)) for (const d of h.drivers) evidence.push({ source: 'server_version', driver: d, detail: clip(input.serverVersion), weight: h.weight });
  }
  if (input.sysDescr) {
    for (const s of SIGNATURES) if (s.sysDescr?.test(input.sysDescr)) evidence.push({ source: 'sys_descr', driver: s.driver, detail: clip(input.sysDescr), weight: W_SYSDESCR });
  }
  if (input.ouiVendor) {
    for (const s of SIGNATURES) if (s.oui?.test(input.ouiVendor)) evidence.push({ source: 'oui_vendor', driver: s.driver, detail: clip(input.ouiVendor), weight: W_OUI });
  }
  const scores = new Map<string, { total: number; best: number }>();
  for (const e of evidence) {
    const s = scores.get(e.driver) ?? { total: 0, best: 0 };
    s.total += e.weight;
    s.best = Math.max(s.best, e.weight);
    scores.set(e.driver, s);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1].best - a[1].best || b[1].total - a[1].total);
  const top = ranked[0];
  // A tie between vendors (e.g. a Cisco OUI fits IOS, NX-OS and ASA alike) is not guessed.
  if (!top || (ranked[1] && ranked[1][1].total === top[1].total && ranked[1][1].best === top[1].best)) {
    return { driver: null, confidence: null, evidence };
  }
  const confidence = top[1].best >= 80 ? 'high' : top[1].total >= 40 ? 'medium' : 'low';
  return { driver: top[0], confidence, evidence };
}
