import type { Db } from '../../infrastructure/db.ts';
import { type AutomationKey, automationSetting } from '../automation/index.ts';

// The smart-check part of a collector's configuration (sent with every heartbeat, see
// modules/ingest/heartbeat.ts). Schedules come from the automation settings (catalogue keys
// smart.*), so an administrator changes them in one place; "run now" requests ride along until a
// run answers them.

export const RUNNABLE_CHECKS = ['rogue_dhcp', 'upnp', 'wifi', 'banners'] as const;
export type RunnableCheck = (typeof RUNNABLE_CHECKS)[number];

export const CHECK_AUTOMATION: Record<RunnableCheck | 'dhcp_fingerprints', AutomationKey> = {
  rogue_dhcp: 'smart.rogue_dhcp',
  upnp: 'smart.upnp_audit',
  wifi: 'smart.wifi_analyzer',
  banners: 'smart.banner_probe',
  dhcp_fingerprints: 'smart.dhcp_fingerprint',
};

/** Ports the banner probe may open: the usual device web interfaces. Fixed, not configurable. */
export const BANNER_PORTS = [80, 443, 8080, 8443] as const;
/** How often a collector reports the DHCP fingerprints it overheard, and runs the banner probe over due devices. */
const FINGERPRINT_INTERVAL_SECONDS = 300;
const BANNER_INTERVAL_SECONDS = 1800;

export interface SmartCheckConfig {
  rogue_dhcp: { enabled: boolean; interval_seconds: number; listen_seconds: number };
  upnp: { enabled: boolean; interval_seconds: number };
  wifi: { enabled: boolean; interval_seconds: number };
  banners: { enabled: boolean; interval_seconds: number; ports: number[]; targets: string[] };
  dhcp_fingerprints: { enabled: boolean; interval_seconds: number };
  run_now: { check: RunnableCheck; requested_at: string }[];
}

const minutes = (config: Record<string, unknown>, key: string, fallback: number) => {
  const v = config[key];
  return (typeof v === 'number' && Number.isFinite(v) ? v : fallback) * 60;
};

export async function buildSmartCheckConfig(db: Db, organizationId: string, siteId: string): Promise<SmartCheckConfig> {
  const dhcp = await automationSetting(db, organizationId, siteId, 'smart.rogue_dhcp');
  const upnp = await automationSetting(db, organizationId, siteId, 'smart.upnp_audit');
  const wifi = await automationSetting(db, organizationId, siteId, 'smart.wifi_analyzer');
  const banner = await automationSetting(db, organizationId, siteId, 'smart.banner_probe');
  const fingerprint = await automationSetting(db, organizationId, siteId, 'smart.dhcp_fingerprint');

  const requests = await db.query<{ check_kind: RunnableCheck; requested_at: Date }>(
    `SELECT check_kind, requested_at FROM smart_check_requests WHERE organization_id = $1 AND site_id = $2 AND requested_at > now() - interval '15 minutes' ORDER BY check_kind`,
    [organizationId, siteId],
  );
  // A "run now" of the banner probe re-reads every online device (still capped), not only the ones due.
  const bannerNow = requests.rows.some((r) => r.check_kind === 'banners');
  let targets: string[] = [];
  if (banner.enabled || bannerNow) {
    const hours = bannerNow ? 0 : Number(banner.config.per_device_hours ?? 24);
    const max = Number(banner.config.max_devices_per_run ?? 32);
    // Devices seen in the last day that were not probed within `per_device_hours`, never-probed first.
    targets = (
      await db.query<{ ip: string }>(
        `SELECT host(d.current_ip) AS ip
           FROM devices d LEFT JOIN device_banner_probes p ON p.organization_id = d.organization_id AND p.device_id = d.id
          WHERE d.organization_id = $1 AND d.site_id = $2 AND d.current_ip IS NOT NULL AND family(d.current_ip) = 4
            AND d.status = 'online' AND d.last_seen_at > now() - interval '1 day'
            AND (p.last_probed_at IS NULL OR p.last_probed_at < now() - make_interval(hours => $3))
          ORDER BY p.last_probed_at NULLS FIRST, d.current_ip
          LIMIT $4`,
        [organizationId, siteId, hours, max],
      )
    ).rows.map((r) => r.ip);
  }
  return {
    rogue_dhcp: { enabled: dhcp.enabled, interval_seconds: minutes(dhcp.config, 'interval_minutes', 15), listen_seconds: Number(dhcp.config.listen_seconds ?? 4) },
    upnp: { enabled: upnp.enabled, interval_seconds: minutes(upnp.config, 'interval_minutes', 60) },
    wifi: { enabled: wifi.enabled, interval_seconds: minutes(wifi.config, 'interval_minutes', 10) },
    banners: { enabled: banner.enabled, interval_seconds: BANNER_INTERVAL_SECONDS, ports: [...BANNER_PORTS], targets },
    dhcp_fingerprints: { enabled: fingerprint.enabled, interval_seconds: FINGERPRINT_INTERVAL_SECONDS },
    // A request nobody answered within 15 minutes is no longer sent (the collector was offline; the schedule took over).
    run_now: requests.rows.map((r) => ({ check: r.check_kind, requested_at: r.requested_at.toISOString() })),
  };
}
