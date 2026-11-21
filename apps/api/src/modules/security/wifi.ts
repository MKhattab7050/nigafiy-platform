import type { CollectorContext, SmartCheckItem } from '../../common/collector-protocol.ts';
import { normalizeMac, vendorForMac } from '../../common/net.ts';
import type { Db } from '../../infrastructure/db.ts';
import { emitEvent } from '../events/index.ts';
import { approvedValues } from './dhcp.ts';
import { type FindingInput, syncFindings } from './findings.ts';
import { type WifiLink, type WifiNet, analyzeWifi } from './wifi-analysis.ts';

// Wi-Fi analyzer (check 'wifi'): the collector host's own Wi-Fi link and the networks its adapter
// hears. Everything is measured from the collector's location only (said in every finding).

type WifiBlock = NonNullable<SmartCheckItem['wifi']>;
type NetIn = WifiBlock['networks'][number];

const toNet = (n: NetIn): WifiNet => ({
  ssid: n.ssid,
  bssid: normalizeMac(n.bssid),
  channel: n.channel ?? null,
  band: n.band ?? null,
  frequency_mhz: n.frequency_mhz ?? null,
  signal_pct: n.signal_pct ?? null,
  rssi_dbm: n.rssi_dbm ?? null,
  security: n.security ?? null,
  auth: n.auth ?? null,
  cipher: n.cipher ?? null,
});

export function summarizeWifi(block: WifiBlock | undefined): Record<string, unknown> {
  if (!block) return {};
  return { platform: block.platform, connected: block.connected, ssid: block.link?.ssid ?? null, networks: block.networks.length };
}

export async function processWifiScan(db: Db, c: CollectorContext, item: SmartCheckItem, now: Date): Promise<void> {
  const block = item.wifi;
  if (!block) return;
  const at = new Date(item.ts);
  const networks = block.networks.map(toNet);
  const link: WifiLink | null = block.link ? { ...toNet(block.link), rx_mbps: block.link.rx_mbps ?? null, tx_mbps: block.link.tx_mbps ?? null } : null;
  const expected = await approvedValues(db, c.organizationId, c.siteId, 'wifi_bssid');
  const { bands, findings } = analyzeWifi({ connected: block.connected, link, networks, expectedBssids: expected, vendorOf: vendorForMac });

  const l = block.connected ? link : null;
  await db.query(
    `INSERT INTO wifi_links (organization_id, site_id, collector_id, platform, interface, connected, ssid, bssid, band, channel, frequency_mhz, signal_pct, rssi_dbm, rx_mbps, tx_mbps, security, auth, cipher, phy, analysis, observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (organization_id, collector_id) DO UPDATE
        SET site_id = EXCLUDED.site_id, platform = EXCLUDED.platform, interface = EXCLUDED.interface, connected = EXCLUDED.connected, ssid = EXCLUDED.ssid,
            bssid = EXCLUDED.bssid, band = EXCLUDED.band, channel = EXCLUDED.channel, frequency_mhz = EXCLUDED.frequency_mhz, signal_pct = EXCLUDED.signal_pct,
            rssi_dbm = EXCLUDED.rssi_dbm, rx_mbps = EXCLUDED.rx_mbps, tx_mbps = EXCLUDED.tx_mbps, security = EXCLUDED.security, auth = EXCLUDED.auth,
            cipher = EXCLUDED.cipher, phy = EXCLUDED.phy, analysis = EXCLUDED.analysis, observed_at = EXCLUDED.observed_at`,
    [
      c.organizationId,
      c.siteId,
      c.id,
      block.platform,
      block.interface ?? null,
      block.connected,
      l?.ssid ?? null,
      l?.bssid ?? null,
      l ? (l.band ?? (l.channel !== null ? (l.channel <= 14 ? '2.4' : '5') : null)) : null,
      l?.channel ?? null,
      l?.frequency_mhz ?? null,
      l?.signal_pct ?? null,
      l?.rssi_dbm ?? null,
      l?.rx_mbps ?? null,
      l?.tx_mbps ?? null,
      l?.security ?? null,
      l?.auth ?? null,
      l?.cipher ?? null,
      block.link?.phy ?? null,
      JSON.stringify({ bands }),
      at,
    ],
  );
  if (l) {
    await db.query(
      `INSERT INTO wifi_link_samples (organization_id, collector_id, ts, signal_pct, rssi_dbm, rx_mbps, tx_mbps, channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [c.organizationId, c.id, at, l.signal_pct, l.rssi_dbm, l.rx_mbps, l.tx_mbps, l.channel],
    );
    // Keep 30 days of link samples per collector.
    await db.query(`DELETE FROM wifi_link_samples WHERE organization_id = $1 AND collector_id = $2 AND ts < $3::timestamptz - interval '30 days'`, [c.organizationId, c.id, at]);
  }
  for (const n of networks) {
    await db.query(
      `INSERT INTO wifi_networks (organization_id, site_id, collector_id, bssid, ssid, channel, band, frequency_mhz, signal_pct, rssi_dbm, security, auth, cipher, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (organization_id, collector_id, bssid) DO UPDATE
          SET site_id = EXCLUDED.site_id, ssid = EXCLUDED.ssid, channel = EXCLUDED.channel, band = EXCLUDED.band, frequency_mhz = EXCLUDED.frequency_mhz,
              signal_pct = EXCLUDED.signal_pct, rssi_dbm = EXCLUDED.rssi_dbm, security = EXCLUDED.security, auth = EXCLUDED.auth, cipher = EXCLUDED.cipher,
              last_seen_at = EXCLUDED.last_seen_at`,
      [c.organizationId, c.siteId, c.id, n.bssid, n.ssid, n.channel, n.band, n.frequency_mhz ?? null, n.signal_pct, n.rssi_dbm, n.security, n.auth, n.cipher, at],
    );
  }
  // Networks not heard for a day are gone from this location.
  await db.query(`DELETE FROM wifi_networks WHERE organization_id = $1 AND collector_id = $2 AND last_seen_at < $3::timestamptz - interval '1 day'`, [c.organizationId, c.id, at]);

  const prefix = `${c.id}|`;
  const inputs: FindingInput[] = findings.map((f) => ({
    kind: f.kind,
    key: `${prefix}${f.key}`,
    severity: f.severity,
    title: f.title,
    details: { ...f.details, evidence: f.evidence, confidence: f.confidence, collector: c.name, collector_id: c.id, measured_from: `Wi-Fi adapter of collector "${c.name}"` },
  }));
  const opened = await syncFindings(db, c.organizationId, c.siteId, 'wifi', inputs, now, { keyPrefixes: [prefix], resolution: 'No longer observed by the collector’s Wi-Fi adapter' });
  for (const f of opened) {
    if (f.severity === 'info') continue;
    await emitEvent(db, c.organizationId, {
      siteId: c.siteId,
      collectorId: c.id,
      type: f.kind === 'wifi_evil_twin' ? 'wifi_evil_twin' : 'wifi_issue',
      severity: f.severity,
      title: f.title,
      details: f.details,
      source: 'collector',
      occurredAt: at,
    });
  }
}
