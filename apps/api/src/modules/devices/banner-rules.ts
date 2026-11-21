import type { Confidence, DeviceType } from '@lan-detective/shared-types';

/**
 * Web banner identification — deterministic rules, first match wins.
 *
 * Input: what a device's own web server said about itself when the collector fetched its start
 * page (the page <title>, the Server header) and the subject/issuer of its TLS certificate. Device
 * web pages name their product far more often than any other protocol does: printers, NAS, cameras
 * and router administration pages are recognised by it. Generic servers (Apache, nginx) settle nothing.
 */

export interface BannerHints {
  http_title?: string;
  http_server?: string;
  tls_subject?: string;
  tls_issuer?: string;
}

export interface BannerResult {
  type: DeviceType;
  confidence: Confidence;
  evidence: string;
}

interface Rule {
  re: RegExp;
  type: DeviceType;
  confidence: Confidence;
  what: string;
}

const RULES: Rule[] = [
  { re: /integrated lights-out|\bilo\s?\d|idrac|supermicro bmc|ipmi/i, type: 'server', confidence: 'high', what: 'a server management controller' },
  { re: /proxmox|vmware esxi|\besxi\b|vcenter|xen ?server|hyper-v/i, type: 'server', confidence: 'high', what: 'a virtualization host' },
  { re: /synology|diskstation|\bdsm\b|qnap|\bqts\b|truenas|freenas|unraid|readynas|my ?cloud|asustor|terramaster/i, type: 'nas', confidence: 'high', what: 'a NAS' },
  { re: /hikvision|app-webs|dahua|dnvrs-webs|reolink|amcrest|foscam|uniview|axis communications|network camera|ip ?camera|\bnvr\b|\bdvr\b|ipcam/i, type: 'camera', confidence: 'high', what: 'a camera or video recorder' },
  { re: /laserjet|officejet|deskjet|pagewide|hp http server|embedded web server|\bews\b|brother|epson|canon|kyocera|ricoh|lexmark|xerox|konica|imagerunner|bizhub|\bprinter\b/i, type: 'printer', confidence: 'high', what: 'a printer' },
  { re: /pfsense|opnsense|fortigate|fortinet|sonicwall|sophos|watchguard|palo alto|check point|untangle/i, type: 'firewall', confidence: 'high', what: 'a firewall' },
  { re: /unifi|ubiquiti|omada|aruba instant|ruckus|cisco meraki|access point/i, type: 'access_point', confidence: 'medium', what: 'a wireless access point or its controller' },
  { re: /procurve|jetstream|catalyst|\bswitch\b.*(web|management)|smart switch|managed switch/i, type: 'switch', confidence: 'medium', what: 'a managed switch' },
  { re: /routeros|mikrotik|openwrt|luci|dd-wrt|tp-link|netgear|fritz!?box|linksys|asus ?wrt|asusrouter|edgeos|draytek|zyxel|huawei (hg|router)|\brouter\b|gateway login/i, type: 'router', confidence: 'medium', what: 'a router administration page' },
  { re: /microsoft-iis/i, type: 'server', confidence: 'medium', what: 'a Windows server (IIS)' },
];

/** Classify from banner hints. Returns null when nothing in the banner names a product. */
export function classifyBanner(h: BannerHints): BannerResult | null {
  const fields: [string, string | undefined][] = [
    ['page title', h.http_title],
    ['Server header', h.http_server],
    ['TLS certificate subject', h.tls_subject],
    ['TLS certificate issuer', h.tls_issuer],
  ];
  for (const rule of RULES) {
    for (const [label, value] of fields) {
      if (!value) continue;
      const hit = rule.re.exec(value);
      if (hit) {
        return { type: rule.type, confidence: rule.confidence, evidence: `Its web interface identifies ${rule.what}: ${label} "${value}" contains "${hit[0]}"` };
      }
    }
  }
  return null;
}
