import { withTenant } from '../../infrastructure/db.ts';
import { ROUTER_VENDORS } from './schema.ts';

// Router connection assistant (UX review 2026-11-26, item 13).
//
// Egypt's common ISP routers are ZTE ZXHN H188A (WE, Vodafone), Huawei DG8045 (WE, Vodafone) and
// Zyxel. The assistant says which one the site's gateway is — only from what Nigafiy actually saw:
// the model a driver read after logging in, the gateway's own web page (title, Server header, TLS
// certificate), its UPnP description, and last the vendor registered for its MAC address. Each
// conclusion carries the observation it rests on and how strong it is; nothing is guessed.
//
// Driver maturity: only the Zyxel driver ran against real hardware (VMG3625-T50B). Every other
// driver is built from vendor documentation and captured traffic and is marked "beta".

export type RouterVendor = (typeof ROUTER_VENDORS)[number];
export type GuideId = 'zte_h188a' | 'huawei_dg8045' | 'zyxel' | 'other';
export type DetectionConfidence = 'high' | 'medium' | 'low' | 'none';
export type DriverMaturity = 'tested' | 'beta';

/** Models a driver has been run against on real hardware. A vendor not listed here is beta. */
export const TESTED_MODELS: Partial<Record<RouterVendor, readonly string[]>> = {
  zyxel: ['VMG3625-T50B'],
};

/**
 * "tested" only for a driver that ran on real hardware, and — when the model is known — only for the
 * model it ran on. Not read yet (model unknown) counts as the tested model's driver for zyxel.
 */
export function driverMaturity(vendor: string, model?: string | null): DriverMaturity {
  const tested = TESTED_MODELS[vendor as RouterVendor];
  if (!tested?.length) return 'beta';
  if (!model) return 'tested';
  const m = model.toUpperCase().replace(/\s+/g, '');
  return tested.some((t) => m.includes(t.toUpperCase())) ? 'tested' : 'beta';
}

export function driverTable(): { vendor: RouterVendor; maturity: DriverMaturity; tested_models: readonly string[] }[] {
  return ROUTER_VENDORS.map((v) => ({ vendor: v, maturity: driverMaturity(v), tested_models: TESTED_MODELS[v] ?? [] }));
}

/** What Nigafiy observed about one gateway. Every field is an observation, or absent. */
export interface GatewayObservation {
  /** The model a router driver read after logging in (site_routers.identity). */
  driver_identity?: { vendor?: string | null; model?: string | null } | null;
  http_title?: string | null;
  http_server?: string | null;
  tls_subject?: string | null;
  tls_issuer?: string | null;
  ssdp_model?: string | null;
  ssdp_manufacturer?: string | null;
  ssdp_friendly_name?: string | null;
  hint_model?: string | null;
  /** The vendor registered for the MAC address (OUI). Says who made the board, not which model. */
  mac_vendor?: string | null;
}

export interface Detection {
  guide: GuideId;
  vendor: RouterVendor | null;
  model: string | null;
  confidence: DetectionConfidence;
  /** One entry per observation the conclusion rests on, in the words of what was seen. */
  evidence: { source: 'driver' | 'web_page' | 'upnp' | 'mac_vendor'; field: string; value: string; matched: string }[];
}

interface ModelRule {
  re: RegExp;
  guide: GuideId;
  vendor: RouterVendor;
  model: string | null;
}

// Exact models first (they name the product), then vendor-only words.
const MODEL_RULES: ModelRule[] = [
  { re: /H188A/i, guide: 'zte_h188a', vendor: 'zte', model: 'ZTE ZXHN H188A' },
  { re: /DG8045/i, guide: 'huawei_dg8045', vendor: 'huawei', model: 'Huawei DG8045' },
  { re: /VMG3625(-?T50B)?/i, guide: 'zyxel', vendor: 'zyxel', model: 'Zyxel VMG3625-T50B' },
];
const VENDOR_RULES: ModelRule[] = [
  { re: /\bZXHN\b|\bZTE\b/i, guide: 'other', vendor: 'zte', model: null },
  { re: /\bHuawei\b|\bEchoLife\b|\bHG8145|\bHG63[03]\b/i, guide: 'other', vendor: 'huawei', model: null },
  { re: /\bZyxel\b|\bZCFG\b|\bVMG\d{4}\b/i, guide: 'zyxel', vendor: 'zyxel', model: null },
];
// MAC vendor (OUI registry) names as they are written there.
const OUI_RULES: { re: RegExp; vendor: RouterVendor; guide: GuideId }[] = [
  { re: /\bZTE\b/i, vendor: 'zte', guide: 'other' },
  { re: /\bHuawei\b/i, vendor: 'huawei', guide: 'other' },
  { re: /\bZyxel\b/i, vendor: 'zyxel', guide: 'zyxel' },
];

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s ? s.slice(0, 200) : null;
};

/** Pure: what the observations say about the gateway's model, and on what grounds. */
export function detectRouterModel(o: GatewayObservation): Detection {
  const driverModel = clean(o.driver_identity?.model);
  const named: { source: Detection['evidence'][number]['source']; field: string; value: string }[] = [];
  if (driverModel) named.push({ source: 'driver', field: 'model read by the driver', value: driverModel });
  for (const [field, value] of [
    ['page title', o.http_title],
    ['Server header', o.http_server],
    ['TLS certificate subject', o.tls_subject],
    ['TLS certificate issuer', o.tls_issuer],
  ] as const) {
    const v = clean(value);
    if (v) named.push({ source: 'web_page', field, value: v });
  }
  for (const [field, value] of [
    ['UPnP model', o.ssdp_model],
    ['UPnP friendly name', o.ssdp_friendly_name],
    ['UPnP manufacturer', o.ssdp_manufacturer],
    ['advertised model', o.hint_model],
  ] as const) {
    const v = clean(value);
    if (v) named.push({ source: 'upnp', field, value: v });
  }

  // 1. An exact model named anywhere. The driver's own reading is strongest; a web page or UPnP
  //    description naming the model is still the device naming itself.
  for (const rule of MODEL_RULES) {
    const hits = named.flatMap((n) => {
      const m = rule.re.exec(n.value);
      return m ? [{ ...n, matched: m[0] }] : [];
    });
    if (hits.length) return { guide: rule.guide, vendor: rule.vendor, model: rule.model, confidence: 'high', evidence: hits };
  }

  // 2. The vendor named by the device itself, model unknown.
  for (const rule of VENDOR_RULES) {
    const hits = named.flatMap((n) => {
      const m = rule.re.exec(n.value);
      return m ? [{ ...n, matched: m[0] }] : [];
    });
    if (hits.length) return { guide: rule.guide, vendor: rule.vendor, model: driverModel, confidence: 'medium', evidence: hits };
  }

  // 3. Only the MAC vendor: who made the network chip or board. Weak: ISPs rebrand, and some boxes use other makers' boards.
  const mac = clean(o.mac_vendor);
  if (mac) {
    for (const rule of OUI_RULES) {
      const m = rule.re.exec(mac);
      if (m) return { guide: rule.guide, vendor: rule.vendor, model: null, confidence: 'low', evidence: [{ source: 'mac_vendor', field: 'MAC address vendor', value: mac, matched: m[0] }] };
    }
  }
  return { guide: 'other', vendor: null, model: driverModel, confidence: 'none', evidence: [] };
}

export interface AssistantGateway {
  address: string;
  collector: { id: string; name: string };
  device: { id: string; label: string; mac: string | null; vendor: string | null } | null;
  router: { id: string; name: string; vendor: string } | null;
  detection: Detection;
  maturity: DriverMaturity | null;
}

export interface AssistantView {
  site_id: string;
  gateways: AssistantGateway[];
  drivers: ReturnType<typeof driverTable>;
}

type Fingerprint = { hints?: Record<string, string>; ssdp?: Record<string, unknown> };

/** GET /router-assistant: the site's gateways as the Sensors reported them, each with what was observed about it. */
export async function routerAssistant(organizationId: string, siteId: string): Promise<AssistantView> {
  return withTenant(organizationId, async (db) => {
    const rows = (
      await db.query<{
        collector_id: string;
        collector_name: string;
        address: string;
        device_id: string | null;
        device_label: string | null;
        mac: string | null;
        mac_vendor: string | null;
        fingerprint: Fingerprint | null;
        router_id: string | null;
        router_name: string | null;
        router_vendor: string | null;
        identity: { vendor?: string; model?: string } | null;
      }>(
        `SELECT c.id AS collector_id, c.name AS collector_name, host(c.gateway_ip) AS address,
                d.id AS device_id, coalesce(d.display_name, d.hostname, host(d.current_ip)) AS device_label,
                d.primary_mac::text AS mac, d.vendor AS mac_vendor, d.fingerprint,
                r.id AS router_id, r.name AS router_name, r.vendor AS router_vendor, r.identity
           FROM collectors c
           LEFT JOIN LATERAL (
             SELECT * FROM devices d WHERE d.site_id = c.site_id AND d.current_ip = c.gateway_ip
              ORDER BY d.last_seen_at DESC LIMIT 1) d ON true
           LEFT JOIN LATERAL (
             SELECT * FROM site_routers r WHERE r.site_id = c.site_id AND r.address = c.gateway_ip
              ORDER BY r.created_at LIMIT 1) r ON true
          WHERE c.site_id = $1 AND c.gateway_ip IS NOT NULL
          ORDER BY c.last_heartbeat_at DESC NULLS LAST`,
        [siteId],
      )
    ).rows;
    const seen = new Set<string>();
    const gateways: AssistantGateway[] = [];
    for (const r of rows) {
      if (seen.has(r.address)) continue;
      seen.add(r.address);
      const h = r.fingerprint?.hints ?? {};
      const s = r.fingerprint?.ssdp ?? {};
      const str = (v: unknown) => (typeof v === 'string' ? v : null);
      const detection = detectRouterModel({
        driver_identity: r.identity,
        http_title: h.http_title,
        http_server: h.http_server,
        tls_subject: h.tls_subject,
        tls_issuer: h.tls_issuer,
        ssdp_model: str(s.model),
        ssdp_manufacturer: str(s.manufacturer),
        ssdp_friendly_name: str(s.friendly_name),
        hint_model: h.model,
        mac_vendor: r.mac_vendor,
      });
      const vendorForMaturity = r.router_vendor ?? detection.vendor;
      gateways.push({
        address: r.address,
        collector: { id: r.collector_id, name: r.collector_name },
        device: r.device_id ? { id: r.device_id, label: r.device_label ?? r.address, mac: r.mac, vendor: r.mac_vendor } : null,
        router: r.router_id ? { id: r.router_id, name: r.router_name ?? r.address, vendor: r.router_vendor ?? '' } : null,
        detection,
        maturity: vendorForMaturity ? driverMaturity(vendorForMaturity, r.identity?.model ?? (detection.confidence === 'high' ? detection.model : null)) : null,
      });
    }
    return { site_id: siteId, gateways, drivers: driverTable() };
  });
}
