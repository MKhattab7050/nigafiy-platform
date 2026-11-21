/**
 * UPnP port-forward risk — pure and deterministic.
 *
 * A UPnP port mapping makes a service of an internal device reachable from the internet through the
 * router. The risk depends on what usually listens on the internal port and on what the internal
 * device is. The rule list is fixed and documented; the evidence names the rule that matched.
 */

export type Risk = 'critical' | 'warning' | 'info';

export interface MappingFacts {
  protocol: 'TCP' | 'UDP';
  external_port: number;
  internal_port: number;
  description: string | null;
  /** Device type of the internal client, when it is a known device ('router', 'nas', 'camera', …). */
  device_type: string | null;
}

interface Rule {
  ports: number[];
  protocol?: 'TCP' | 'UDP';
  risk: Risk;
  service: string;
  why: string;
}

const RULES: Rule[] = [
  { ports: [3389], risk: 'critical', service: 'Remote Desktop (RDP)', why: 'RDP exposed to the internet is a top ransomware entry point (password guessing, unpatched vulnerabilities).' },
  { ports: [445, 139], protocol: 'TCP', risk: 'critical', service: 'Windows file sharing (SMB)', why: 'SMB must never be reachable from the internet (WannaCry-class worms, credential relay).' },
  { ports: [23, 2323], protocol: 'TCP', risk: 'critical', service: 'Telnet', why: 'Telnet sends passwords in clear text and is the main target of IoT botnets (Mirai).' },
  { ports: [5900, 5901, 5902, 5903], protocol: 'TCP', risk: 'critical', service: 'VNC remote control', why: 'VNC often has weak or no authentication and gives full control of the screen.' },
  { ports: [1433, 1434], risk: 'critical', service: 'Microsoft SQL Server', why: 'Databases must not be reachable from the internet.' },
  { ports: [3306], protocol: 'TCP', risk: 'critical', service: 'MySQL / MariaDB', why: 'Databases must not be reachable from the internet.' },
  { ports: [5432], protocol: 'TCP', risk: 'critical', service: 'PostgreSQL', why: 'Databases must not be reachable from the internet.' },
  { ports: [27017, 27018], protocol: 'TCP', risk: 'critical', service: 'MongoDB', why: 'Databases must not be reachable from the internet.' },
  { ports: [6379], protocol: 'TCP', risk: 'critical', service: 'Redis', why: 'Redis has no authentication by default.' },
  { ports: [9200, 9300], protocol: 'TCP', risk: 'critical', service: 'Elasticsearch', why: 'Search clusters exposed to the internet leak their data.' },
  { ports: [11211], risk: 'critical', service: 'Memcached', why: 'Exposed memcached leaks data and is abused for DDoS amplification.' },
  { ports: [22], protocol: 'TCP', risk: 'warning', service: 'SSH', why: 'SSH from the internet invites password guessing; allow keys only, or use a VPN.' },
  { ports: [21], protocol: 'TCP', risk: 'warning', service: 'FTP', why: 'FTP sends passwords in clear text.' },
  { ports: [161, 162], protocol: 'UDP', risk: 'warning', service: 'SNMP', why: 'SNMP from the internet leaks device details and is used for amplification.' },
  { ports: [1900], protocol: 'UDP', risk: 'warning', service: 'UPnP/SSDP', why: 'SSDP from the internet is abused for DDoS amplification.' },
  { ports: [554, 8554], risk: 'warning', service: 'RTSP video stream', why: 'Camera streams exposed to the internet are often viewable without a password.' },
  { ports: [8291], protocol: 'TCP', risk: 'critical', service: 'MikroTik Winbox (router administration)', why: 'Router administration must not be reachable from the internet.' },
  { ports: [5000, 5001], protocol: 'TCP', risk: 'warning', service: 'NAS administration (e.g. Synology DSM)', why: 'NAS administration pages are a frequent ransomware target.' },
  { ports: [10000], protocol: 'TCP', risk: 'warning', service: 'Webmin administration', why: 'Server administration must not be reachable from the internet.' },
];

const WEB_PORTS = [80, 443, 8080, 8443, 8000, 8081, 8888];
const ADMIN_DEVICE_TYPES: Record<string, string> = { router: 'router', firewall: 'firewall', switch: 'switch', access_point: 'access point', nas: 'NAS', camera: 'camera', printer: 'printer' };
const ADMIN_TEXT = /\b(admin|webui|web ui|management|config|router|nvr|dvr|camera)\b/i;

export interface RiskResult {
  risk: Risk;
  service: string | null;
  reason: string;
}

/** Classify one mapping. The internal port decides what service is exposed; the external port is what the internet sees. */
export function mappingRisk(m: MappingFacts): RiskResult {
  for (const port of [m.internal_port, m.external_port]) {
    const rule = RULES.find((r) => r.ports.includes(port) && (!r.protocol || r.protocol === m.protocol));
    if (rule) {
      const via = port === m.internal_port ? `internal port ${m.internal_port}` : `external port ${m.external_port}`;
      return { risk: rule.risk, service: rule.service, reason: `${rule.service} (${m.protocol} ${via}): ${rule.why}` };
    }
  }
  if (m.protocol === 'TCP' && WEB_PORTS.includes(m.internal_port)) {
    const adminType = m.device_type ? ADMIN_DEVICE_TYPES[m.device_type] : undefined;
    if (adminType) {
      return { risk: 'critical', service: 'Device administration page', reason: `Web port ${m.internal_port} of a ${adminType}: its administration page is reachable from the internet.` };
    }
    if (m.description && ADMIN_TEXT.test(m.description)) {
      return { risk: 'warning', service: 'Web administration page', reason: `Web port ${m.internal_port} described as "${m.description}": looks like an administration page reachable from the internet.` };
    }
    return { risk: 'warning', service: 'Web server', reason: `Web port ${m.internal_port} is reachable from the internet. Make sure it is meant to be public and kept up to date.` };
  }
  return { risk: 'info', service: null, reason: `${m.protocol} port ${m.external_port} → internal port ${m.internal_port}${m.description ? ` ("${m.description}")` : ''}. Opened by a program on the device through UPnP; not a known risky service.` };
}

/** Identity of a mapping for "this is expected" and for de-duplicating findings. */
export const mappingKey = (gateway: string, m: { protocol: string; external_port: number; internal_client: string; internal_port: number }) =>
  `${gateway}|${m.protocol}|${m.external_port}|${m.internal_client}:${m.internal_port}`;
