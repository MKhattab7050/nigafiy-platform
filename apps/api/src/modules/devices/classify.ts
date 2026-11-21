import type { Confidence, DeviceType } from '@lan-detective/shared-types';
import { classifyBanner } from './banner-rules.ts';
import { classifyDhcp } from './dhcp-fingerprint.ts';

/**
 * Device classification from evidence — deterministic rules, first match wins.
 *
 * Inputs are things the device itself announced (mDNS services, UPnP description, NetBIOS name),
 * plus two facts we observed (it is the collector's default gateway; its MAC is a private/randomized
 * one). Every result carries the evidence it was derived from and a confidence:
 *   high   — the device explicitly announced what it is (e.g. an IPP printer service, an iPhone name)
 *   medium — a strong but indirect sign
 *   low    — a statistical hint only (shown as such in the UI)
 * No rule fires without evidence; with none, the device stays "unclassified".
 */
export interface Fingerprint {
  names?: { source: string; name: string }[];
  services?: string[];
  hints?: Record<string, string>;
  ssdp?: { server?: string; friendly_name?: string; manufacturer?: string; model?: string; device_types?: string[] };
}

export interface ClassifyFacts {
  fingerprint: Fingerprint;
  hostname: string | null;
  vendor: string | null;
  macRandomized: boolean;
  /** Set when a collector uses this address as its default gateway. */
  gatewayOf: string | null;
}

export interface Classification {
  type: DeviceType;
  confidence: Confidence;
  evidence: string[];
}

const MOBILE_NAME = /\b(iphone|ipad|ipod|android|galaxy|pixel|redmi|xiaomi|poco|huawei|honor|oppo|vivo|realme|oneplus|infinix|tecno|nokia|moto[- ]?[a-z]\d|sm-[a-z]\d{3})/i;
const TV_NAME = /\b(tv|bravia|chromecast|roku|fire ?tv|shield|webos|tizen|apple ?tv|mi ?box|set-?top)\b/i;
const NAS_NAME = /\b(nas|synology|diskstation|qnap|truenas|freenas|readynas|mycloud|terramaster|asustor)\b/i;
const CAMERA_NAME = /\b(camera|ipcam|ip ?cam|hikvision|dahua|reolink|foscam|amcrest|axis|nvr|dvr)\b/i;
const PRINTER_NAME = /\b(printer|laserjet|officejet|deskjet|pixma|ecotank|workforce|imagerunner|mfc-|hl-l?\d|brother|epson|lexmark|kyocera|ricoh)\b/i;
const AP_NAME = /\b(access ?point|unifi|uap-|eap\d|omada|aironet|mesh|range ?extender|repeater|deco)\b/i;

export function classify(f: ClassifyFacts): Classification | null {
  const fp = f.fingerprint;
  const services = fp.services ?? [];
  const has = (...prefixes: string[]) => prefixes.find((p) => services.some((s) => s === p || s.startsWith(`${p}.`) || s.startsWith(p)));
  const names = (fp.names ?? []).map((n) => n.name);
  const model = fp.hints?.model ?? fp.ssdp?.model ?? '';
  const product = fp.hints?.product ?? '';
  const upnp = fp.ssdp?.device_types ?? [];
  const text = [...names, f.hostname ?? '', model, product, fp.hints?.friendly_name ?? '', fp.ssdp?.friendly_name ?? '', fp.ssdp?.manufacturer ?? '', fp.ssdp?.server ?? ''].join(' | ');
  const named = (re: RegExp) => re.exec(text)?.[0];
  const svc = (s: string) => `Announces the ${s} service over mDNS`;
  const result = (type: DeviceType, confidence: Confidence, ...evidence: (string | false | undefined)[]): Classification => ({
    type,
    confidence,
    evidence: evidence.filter((e): e is string => Boolean(e)),
  });
  const modelNote = (model || product) && `Reports model "${model || product}"`;

  // ── infrastructure ──
  if (upnp.includes('InternetGatewayDevice') || upnp.includes('WANDevice')) {
    return result('router', 'high', 'Announces itself as a UPnP Internet Gateway Device', f.gatewayOf ? `Collector "${f.gatewayOf}" uses it as default gateway` : undefined, modelNote);
  }
  if (f.gatewayOf) return result('router', 'medium', `Collector "${f.gatewayOf}" uses this address as its default gateway`);

  // ── printers ──
  const printSvc = has('_ipp._tcp', '_ipps._tcp', '_printer._tcp', '_pdl-datastream._tcp', '_scanner._tcp', '_uscan._tcp');
  if (printSvc || upnp.includes('Printer')) return result('printer', 'high', printSvc ? svc(printSvc) : 'Announces itself as a UPnP printer', modelNote);

  // ── cameras ──
  const camSvc = has('_axis-video._tcp', '_rtsp._tcp', '_onvif._tcp');
  if (camSvc) return result('camera', camSvc === '_rtsp._tcp' ? 'medium' : 'high', svc(camSvc), modelNote);
  if (upnp.some((t) => /camera|NetworkVideoTransmitter/i.test(t))) return result('camera', 'high', 'Announces itself as a UPnP network camera', modelNote);

  // ── TVs and streaming boxes ──
  const castSvc = has('_googlecast._tcp', '_androidtvremote2._tcp', '_roku-rcp._tcp', '_amzn-wplay._tcp', '_nvstream._tcp');
  if (castSvc) return result('media_player', 'high', svc(castSvc), modelNote);
  if (/appletv/i.test(model)) return result('media_player', 'high', `Reports model "${model}"`);
  if (upnp.includes('MediaRenderer') || upnp.includes('tvdevice')) return result('media_player', 'medium', 'Announces itself as a UPnP media renderer', modelNote);

  // ── NAS ──
  const nasName = named(NAS_NAME);
  if (nasName && (has('_smb._tcp', '_afpovertcp._tcp', '_nfs._tcp') || upnp.length > 0)) return result('nas', 'high', `Name or model contains "${nasName}"`, 'Offers file sharing');
  if (has('_adisk._tcp')) return result('nas', 'medium', svc('_adisk._tcp (Time Machine disk)'));

  // ── phones and tablets ──
  // The DHCP vendor class is set by the operating system's DHCP client, not by the user.
  const dhcpClass = fp.hints?.dhcp_vendor_class ?? '';
  if (/^android-dhcp/i.test(dhcpClass)) return result('mobile', 'high', `Its DHCP client identifies itself as "${dhcpClass}" (Android)`, f.macRandomized && 'Uses a private (randomized) Wi-Fi MAC address');
  const mobileName = named(MOBILE_NAME);
  if (mobileName) return result('mobile', 'high', `Its announced name contains "${mobileName}"`, f.macRandomized && 'Uses a private (randomized) Wi-Fi MAC address');
  const appleMobile = has('_apple-mobdev2._tcp', '_apple-pairable._tcp', '_remotepairing._tcp');
  if (appleMobile) return result('mobile', 'high', svc(appleMobile));

  // ── DHCP fingerprint (option 55 / 60, set by the operating system's DHCP client) ──
  // Without an option list, a vendor class alone only decides when it names the product outright (high).
  const dhcpGuess = fp.hints?.dhcp_prl || dhcpClass ? classifyDhcp(fp.hints?.dhcp_prl ?? '', dhcpClass) : null;
  const dhcpOs = dhcpGuess && (fp.hints?.dhcp_prl || dhcpGuess.confidence === 'high') ? dhcpGuess : null;
  if (dhcpOs?.device_type && dhcpOs.os_family !== 'android') {
    return result(dhcpOs.device_type, dhcpOs.confidence, dhcpOs.evidence, f.macRandomized && dhcpOs.device_type === 'mobile' && 'Uses a private (randomized) Wi-Fi MAC address');
  }
  if (dhcpOs?.os_family === 'android') return result('mobile', 'high', dhcpOs.evidence, f.macRandomized && 'Uses a private (randomized) Wi-Fi MAC address');
  if (dhcpOs?.os_family === 'apple' && f.macRandomized) return result('mobile', 'medium', dhcpOs.evidence, 'Uses a private (randomized) Wi-Fi MAC address, which iPhones and iPads do by default');

  // ── computers ──
  if (/^(macbook|imac|macmini|macpro|mac\d)/i.test(model.replace(/\s/g, '')) || has('_afpovertcp._tcp')) {
    return result('apple_computer', 'high', modelNote || svc('_afpovertcp._tcp'));
  }
  const netbios = fp.names?.find((n) => n.source === 'netbios');
  if (netbios) return result('windows_computer', has('_smb._tcp') ? 'high' : 'medium', `Answers NetBIOS name queries as "${netbios.name}" (Windows networking)`);
  if (/^MSFT /i.test(dhcpClass)) return result('windows_computer', 'medium', `Its DHCP client identifies itself as "${dhcpClass}" (Microsoft Windows)`);
  const linuxSvc = has('_workstation._tcp', '_sftp-ssh._tcp', '_ssh._tcp');
  if (linuxSvc) return result('linux_computer', 'medium', svc(linuxSvc));
  if (has('_companion-link._tcp', '_airplay._tcp', '_raop._tcp')) {
    // Apple device of some kind; a randomized MAC makes a phone or tablet the likelier reading.
    return f.macRandomized
      ? result('mobile', 'medium', 'Announces Apple device services over mDNS', 'Uses a private (randomized) Wi-Fi MAC address')
      : result('apple_computer', 'low', 'Announces Apple device services over mDNS');
  }

  // ── smart-home / IoT ──
  const iotSvc = has('_hap._tcp', '_matter._tcp', '_matterc._udp', '_esphomelib._tcp', '_hue._tcp', '_shelly._tcp', '_miio._udp', '_homekit._tcp', '_tuya._tcp');
  if (iotSvc) return result('iot', 'high', svc(iotSvc), modelNote);

  // ── web banner (page title, Server header, TLS certificate of the device's own web interface) ──
  const banner = classifyBanner({ http_title: fp.hints?.http_title, http_server: fp.hints?.http_server, tls_subject: fp.hints?.tls_subject, tls_issuer: fp.hints?.tls_issuer });
  if (banner) return result(banner.type, banner.confidence, banner.evidence, modelNote);
  if (dhcpOs?.os_family === 'apple') return result('apple_computer', 'low', dhcpOs.evidence, 'Not a randomized MAC address, so a Mac is likelier than an iPhone or iPad');

  // ── name-only signals ──
  const byName: [RegExp, DeviceType][] = [
    [PRINTER_NAME, 'printer'],
    [CAMERA_NAME, 'camera'],
    [TV_NAME, 'media_player'],
    [AP_NAME, 'access_point'],
  ];
  for (const [re, type] of byName) {
    const hit = named(re);
    if (hit) return result(type, 'medium', `Its announced name or model contains "${hit}"`);
  }

  // ── weakest signal: a randomized MAC and nothing else ──
  if (f.macRandomized) {
    return result(
      'mobile',
      'low',
      'Uses a private (randomized) Wi-Fi MAC address, which phones and tablets do by default (some laptops do too)',
      'It did not answer any identification protocol — phones usually stay silent while locked',
    );
  }
  return null;
}

const NAME_PRIORITY = ['mdns', 'dhcp', 'netbios', 'ssdp'];
/** The best self-announced name: mDNS hostname, then DHCP hostname, then NetBIOS, then UPnP friendly name. */
export function bestName(fp: Fingerprint): { name: string; source: string } | null {
  for (const source of NAME_PRIORITY) {
    const hit = fp.names?.find((n) => n.source === source);
    if (hit) return { name: hit.name, source };
  }
  return null;
}

/** Devices do not answer on every sweep: keep earlier clues and add new ones. */
export function mergeFingerprint(old: Fingerprint, fresh: Fingerprint): Fingerprint {
  const names = [...(old.names ?? [])];
  for (const n of fresh.names ?? []) if (!names.some((x) => x.source === n.source && x.name.toLowerCase() === n.name.toLowerCase())) names.push(n);
  const services = [...new Set([...(old.services ?? []), ...(fresh.services ?? [])])].sort().slice(0, 40);
  const hints = { ...(old.hints ?? {}), ...(fresh.hints ?? {}) };
  const ssdp = fresh.ssdp ?? old.ssdp;
  return {
    ...(names.length ? { names: names.slice(-8) } : {}),
    ...(services.length ? { services } : {}),
    ...(Object.keys(hints).length ? { hints } : {}),
    ...(ssdp ? { ssdp } : {}),
  };
}
