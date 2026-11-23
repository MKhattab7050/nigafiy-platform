import { z } from 'zod';

/**
 * Every automatic behaviour of Nigafiy, in one typed list. Each one:
 *   - is checked with `automationEnabled()` by the module that owns it before it acts;
 *   - records what it did with `auditSystem()` (metadata.automation = its key);
 *   - can be switched off per organization or per site (PUT /automation/:key).
 *
 * Deliberately absent: anything that is consent or security — authorizing a scan range, enrolling
 * a machine, remote sessions, destructive actions, enabling DNS filtering, entering credentials.
 * Those stay explicit user actions; automations may only suggest them.
 */
export interface AutomationDefinition<C extends z.ZodType = z.ZodType> {
  readonly key: string;
  /** Module that performs (or proposes) it. */
  readonly owner: string;
  readonly defaultEnabled: boolean;
  /** 'act': does something by itself (queues a command, changes an inferred fact). 'suggest': only proposes. */
  readonly kind: 'act' | 'suggest';
  /** Stable key the UI localizes; `description` is the English fallback. */
  readonly descriptionKey: string;
  readonly description: string;
  /** Validates PUT bodies' `config`; its parse of `{}` gives the default config. */
  readonly config: C;
}

const define = <C extends z.ZodType>(d: AutomationDefinition<C>) => d;

export const AUTOMATIONS = [
  define({
    key: 'incident.refresh_measurements',
    owner: 'correlation',
    defaultEnabled: true,
    kind: 'act',
    descriptionKey: 'automation.incident_refresh_measurements',
    description:
      'When a network-path or collector incident opens, ask the site’s online collectors to run every check now so the diagnosis uses fresh measurements.',
    config: z.object({ min_interval_minutes: z.number().int().min(1).max(60).default(5) }).strict(),
  }),
  define({
    key: 'classify.switch_from_snmp',
    owner: 'ports',
    defaultEnabled: true,
    kind: 'act',
    descriptionKey: 'automation.classify_switch_from_snmp',
    description:
      'After a switch answers its first SNMP read, mark the linked device as a switch (inferred, high confidence). A type you set by hand is never changed.',
    config: z.object({}).strict(),
  }),
  define({
    key: 'suggest.monitor_infrastructure',
    owner: 'insights',
    defaultEnabled: true,
    kind: 'suggest',
    descriptionKey: 'automation.suggest_monitor_infrastructure',
    description:
      'Suggest monitoring routers, printers, NAS, cameras, access points and servers that have no check yet. Nothing is created until you accept.',
    config: z.object({ min_confidence: z.enum(['medium', 'high']).default('medium') }).strict(),
  }),
  define({
    key: 'suggest.knowledge_from_incidents',
    owner: 'knowledge',
    defaultEnabled: true,
    kind: 'suggest',
    descriptionKey: 'automation.suggest_knowledge_from_incidents',
    description:
      'When an incident is resolved with a note or has comments, prepare a knowledge-base candidate pre-filled from the incident and its diagnosis. Nothing is published until a person confirms it.',
    config: z.object({}).strict(),
  }),
  // ── Smart network checks (modules/security): read-only observations the collector makes by itself ──
  define({
    key: 'smart.rogue_dhcp',
    owner: 'security',
    defaultEnabled: true,
    kind: 'act',
    descriptionKey: 'automation.smart_rogue_dhcp',
    description:
      'Every 15 minutes the collector sends one DHCPDISCOVER on each network inside an authorized range and lists every DHCP server that answers. It never requests or accepts a lease. An unexpected server raises a critical alert; no answer at all raises a warning.',
    config: z
      .object({ interval_minutes: z.number().int().min(5).max(1440).default(15), listen_seconds: z.number().int().min(2).max(15).default(4) })
      .strict(),
  }),
  define({
    key: 'smart.upnp_audit',
    owner: 'security',
    defaultEnabled: true,
    kind: 'act',
    descriptionKey: 'automation.smart_upnp_audit',
    description:
      'Every hour the collector asks the site’s gateway (inside an authorized range only) which ports UPnP has opened to the internet. Read only: nothing is added or removed. Risky forwards (remote desktop, file sharing, databases, administration pages) are flagged.',
    config: z.object({ interval_minutes: z.number().int().min(15).max(1440).default(60) }).strict(),
  }),
  define({
    key: 'smart.wifi_analyzer',
    owner: 'security',
    defaultEnabled: true,
    kind: 'act',
    descriptionKey: 'automation.smart_wifi_analyzer',
    description:
      'Every 10 minutes the collector reads its own Wi-Fi link and the nearby networks its adapter already sees, then Nigafiy scores channel congestion, recommends a clearer channel and flags weak signal, weak security and look-alike networks.',
    config: z.object({ interval_minutes: z.number().int().min(2).max(1440).default(10) }).strict(),
  }),
  define({
    key: 'smart.banner_probe',
    owner: 'security',
    defaultEnabled: true,
    kind: 'act',
    descriptionKey: 'automation.smart_banner_probe',
    description:
      'At most once a day per device, the collector opens the start page of devices in authorized ranges on ports 80, 443, 8080 and 8443 and reads the page title, server name and certificate to recognise printers, NAS, cameras and router pages. A type you set by hand is never changed.',
    config: z
      .object({ per_device_hours: z.number().int().min(6).max(720).default(24), max_devices_per_run: z.number().int().min(1).max(64).default(32) })
      .strict(),
  }),
  define({
    key: 'smart.dhcp_fingerprint',
    owner: 'security',
    defaultEnabled: true,
    kind: 'act',
    descriptionKey: 'automation.smart_dhcp_fingerprint',
    description:
      'Use the option list that devices’ DHCP clients broadcast (overheard by the passive DHCP listener) to recognise their operating system — Windows, Android, Apple, Linux, ChromeOS, printers, VoIP phones, consoles — as evidence for the device type. A type you set by hand is never changed.',
    config: z.object({}).strict(),
  }),
] as const;

export type AutomationKey = (typeof AUTOMATIONS)[number]['key'];

export const AUTOMATION_KEYS = AUTOMATIONS.map((a) => a.key) as AutomationKey[];

export function automationDefinition(key: string): AutomationDefinition | undefined {
  return AUTOMATIONS.find((a) => a.key === key);
}

export function defaultConfig(key: AutomationKey): Record<string, unknown> {
  return automationDefinition(key)!.config.parse({}) as Record<string, unknown>;
}
