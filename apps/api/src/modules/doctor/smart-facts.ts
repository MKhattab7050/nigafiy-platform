import type { Diagnosis } from '@nigafiy/shared-types';
import type { Db } from '../../infrastructure/db.ts';
import { finalize } from './rules.ts';
import { type DhcpFacts, type WifiDoctorFacts, diagnoseDhcp, diagnoseWifi } from './smart-rules.ts';

// Loads the facts for the smart-check rules from what modules/security stored. Every query filters
// organization_id explicitly (this also runs inside platform transactions, where RLS does not apply).

export async function loadDhcpFacts(db: Db, organizationId: string, siteId: string, now: Date): Promise<DhcpFacts> {
  const servers = await db.query<DhcpFacts['servers'][number]>(
    `SELECT host(server_id) AS server_id, host(source_ip) AS source_ip, server_mac::text AS server_mac, host(offered_ip) AS offered_ip,
            ARRAY(SELECT host(r) FROM unnest(routers) r) AS routers, ARRAY(SELECT host(d) FROM unnest(dns_servers) d) AS dns_servers,
            lease_seconds, expected, first_seen_at, last_offer_at, missed_probes, clients_choosing, last_client_choice_at
       FROM dhcp_servers
      WHERE organization_id = $1 AND site_id = $2
        AND ((last_offer_at IS NOT NULL AND missed_probes < 2) OR last_client_choice_at > $3::timestamptz - interval '1 hour')
      ORDER BY expected NULLS FIRST, server_id`,
    [organizationId, siteId, now],
  );
  const state = (
    await db.query<{ probes: number; last_probe_at: Date | null; consecutive_no_offer: number }>(
      `SELECT probes, last_probe_at, consecutive_no_offer FROM dhcp_probe_state WHERE organization_id = $1 AND site_id = $2`,
      [organizationId, siteId],
    )
  ).rows[0];
  const runs = await db.query<{ summary: { interfaces_probed?: number; listen_errors?: string[] } }>(
    `SELECT summary FROM smart_check_runs WHERE organization_id = $1 AND site_id = $2 AND check_kind = 'rogue_dhcp' ORDER BY ran_at DESC LIMIT 1`,
    [organizationId, siteId],
  );
  const gateways = await db.query<{ ip: string }>(
    `SELECT DISTINCT host(gateway_ip) AS ip FROM collectors WHERE organization_id = $1 AND site_id = $2 AND status = 'active' AND gateway_ip IS NOT NULL`,
    [organizationId, siteId],
  );
  const summary = runs.rows[0]?.summary ?? {};
  return {
    now,
    servers: servers.rows,
    probe: {
      probes: state?.probes ?? 0,
      last_probe_at: state?.last_probe_at ?? null,
      consecutive_no_offer: state?.consecutive_no_offer ?? 0,
      listen_errors: summary.listen_errors ?? [],
      interfaces_probed: summary.interfaces_probed ?? 0,
    },
    gateways: gateways.rows.map((g) => g.ip),
  };
}

interface StoredBand {
  band: '2.4' | '5' | '6';
  current_channel: number | null;
  current_score: number | null;
  level: 'low' | 'medium' | 'high' | null;
  recommended: { channel: number; score: number } | null;
  contributors: { ssid: string; bssid: string; channel: number; signal_pct: number; weight: number }[];
  candidates?: { channel: number; score: number; networks: number }[];
}

export async function loadWifiFacts(db: Db, organizationId: string, siteId: string): Promise<WifiDoctorFacts[]> {
  const rows = await db.query<{
    collector: string;
    connected: boolean;
    ssid: string | null;
    bssid: string | null;
    band: '2.4' | '5' | '6' | null;
    channel: number | null;
    signal_pct: number | null;
    rssi_dbm: number | null;
    rx_mbps: number | null;
    tx_mbps: number | null;
    analysis: { bands?: StoredBand[] };
    observed_at: Date;
  }>(
    `SELECT c.name AS collector, w.connected, w.ssid, w.bssid::text AS bssid, w.band, w.channel, w.signal_pct, w.rssi_dbm, w.rx_mbps, w.tx_mbps, w.analysis, w.observed_at
       FROM wifi_links w JOIN collectors c ON c.organization_id = w.organization_id AND c.id = w.collector_id
      WHERE w.organization_id = $1 AND w.site_id = $2 AND c.status = 'active' AND w.observed_at > now() - interval '1 day'
      ORDER BY c.name`,
    [organizationId, siteId],
  );
  return rows.rows.map((r) => {
    const band = (r.analysis.bands ?? []).find((b) => b.band === r.band && b.current_channel !== null);
    const derived = r.rssi_dbm ?? (r.signal_pct !== null ? Math.round(r.signal_pct / 2 - 100) : null);
    return {
      observed_at: r.observed_at,
      collector: r.collector,
      connected: r.connected,
      link:
        r.connected && r.bssid
          ? { ssid: r.ssid ?? '', bssid: r.bssid, band: r.band, channel: r.channel, rssi_dbm: derived, rssi_measured: r.rssi_dbm !== null, signal_pct: r.signal_pct, rx_mbps: r.rx_mbps, tx_mbps: r.tx_mbps }
          : null,
      channel: band
        ? {
            level: band.level,
            score: band.current_score,
            networks: band.candidates?.find((c) => c.channel === band.current_channel)?.networks ?? band.contributors.length,
            recommended: band.recommended ? { channel: band.recommended.channel, score: band.recommended.score } : null,
            contributors: band.contributors,
          }
        : null,
    };
  });
}

const NO_AFFECTED: Diagnosis['affected'] = { devices_offline: 0, devices_total: 0, checks: [] };

/** Every smart-check diagnosis of a site (DHCP, then Wi-Fi per collector). `attentionOnly` leaves out healthy / not-measured ones. */
export async function diagnoseSmartChecks(db: Db, organizationId: string, siteId: string, now = new Date(), attentionOnly = false): Promise<Diagnosis[]> {
  const out: Diagnosis[] = [];
  const dhcp = await loadDhcpFacts(db, organizationId, siteId, now);
  out.push(finalize(diagnoseDhcp(dhcp), NO_AFFECTED, [], now));
  for (const w of await loadWifiFacts(db, organizationId, siteId)) {
    for (const core of diagnoseWifi(w)) out.push(finalize(core, NO_AFFECTED, [], now));
  }
  return attentionOnly ? out.filter((d) => d.fault_domain !== 'healthy' && d.fault_domain !== 'insufficient_data') : out;
}
