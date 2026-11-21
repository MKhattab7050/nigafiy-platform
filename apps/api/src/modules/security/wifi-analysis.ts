/**
 * Wi-Fi analysis — pure, deterministic functions (same input → same output, unit-tested).
 *
 * Input: what the collector host's own Wi-Fi adapter reported (its current link and the networks
 * in its last scan). Everything is measured from the collector's location only, which the UI and
 * the evidence say.
 *
 *  - channel congestion per band, with a recommended channel and the networks that weigh on it;
 *  - weak signal, low link (PHY) rate;
 *  - insecure security on the site's own SSID (open, WEP, WPA/TKIP);
 *  - a possible "evil twin": our SSID announced with different security or by unknown hardware.
 */

export type Band = '2.4' | '5' | '6';
export type SecurityClass = 'open' | 'wep' | 'wpa_tkip' | 'wpa2' | 'enterprise' | 'wpa3' | 'unknown';
export type Severity = 'info' | 'warning' | 'critical';
export type Confidence = 'high' | 'medium' | 'low';

export interface WifiNet {
  ssid: string;
  bssid: string;
  channel: number | null;
  band: Band | null;
  frequency_mhz?: number | null;
  signal_pct: number | null;
  rssi_dbm: number | null;
  security: string | null;
  auth: string | null;
  cipher: string | null;
}

export interface WifiLink extends WifiNet {
  rx_mbps: number | null;
  tx_mbps: number | null;
}

export function bandOf(n: Pick<WifiNet, 'band' | 'channel' | 'frequency_mhz'>): Band | null {
  if (n.band) return n.band;
  if (n.frequency_mhz) return n.frequency_mhz < 3000 ? '2.4' : n.frequency_mhz < 5925 ? '5' : '6';
  if (n.channel === null) return null;
  return n.channel <= 14 ? '2.4' : '5';
}

/** RSSI in dBm: measured when the platform reports it, otherwise derived from the Windows-style quality % (q = 2 × (dBm + 100)). */
export function rssiOf(n: Pick<WifiNet, 'rssi_dbm' | 'signal_pct'>): { dbm: number; measured: boolean } | null {
  if (n.rssi_dbm !== null && n.rssi_dbm !== undefined) return { dbm: n.rssi_dbm, measured: true };
  if (n.signal_pct !== null && n.signal_pct !== undefined) return { dbm: Math.round(n.signal_pct / 2 - 100), measured: false };
  return null;
}

/** 0..1 — how strongly a network is heard. */
export function strength(n: Pick<WifiNet, 'rssi_dbm' | 'signal_pct'>): number {
  if (n.signal_pct !== null && n.signal_pct !== undefined) return Math.max(0, Math.min(100, n.signal_pct)) / 100;
  const r = rssiOf(n);
  return r ? Math.max(0, Math.min(100, 2 * (r.dbm + 100))) / 100 : 0.5;
}

export function securityClass(n: Pick<WifiNet, 'security' | 'auth' | 'cipher'>): SecurityClass {
  const text = [n.security, n.auth, n.cipher].filter(Boolean).join(' ').toLowerCase();
  if (!text.trim()) return 'unknown';
  if (/wpa3|sae|owe/.test(text)) return 'wpa3';
  if (/enterprise|802\.1x|eap/.test(text)) return 'enterprise';
  if (/wep/.test(text)) return 'wep';
  if (/tkip/.test(text) && !/ccmp|aes|gcmp/.test(text)) return 'wpa_tkip';
  if (/wpa2|rsn|ccmp|aes|gcmp|psk/.test(text)) return /wpa2|rsn|ccmp|aes|gcmp/.test(text) ? 'wpa2' : 'wpa_tkip';
  if (/\bwpa\b|wpa1|wpa-personal|wpa personal/.test(text)) return 'wpa_tkip';
  if (/\bopen\b|\bnone\b|unsecured|--/.test(text)) return 'open';
  return 'unknown';
}

const SECURITY_LABEL: Record<SecurityClass, string> = {
  open: 'Open (no encryption)',
  wep: 'WEP',
  wpa_tkip: 'WPA / TKIP',
  wpa2: 'WPA2',
  enterprise: 'WPA2/3-Enterprise',
  wpa3: 'WPA3',
  unknown: 'Unknown',
};
export const securityLabel = (c: SecurityClass) => SECURITY_LABEL[c];

// ── channel congestion ──

export const CANDIDATES: Record<Band, number[]> = {
  // The three non-overlapping 2.4 GHz channels; 12/13 are not allowed everywhere.
  '2.4': [1, 6, 11],
  // Non-DFS 5 GHz channels: usable in every regulatory domain without radar detection.
  '5': [36, 40, 44, 48, 149, 153, 157, 161],
  // 6 GHz preferred scanning channels.
  '6': [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229],
};

function block5(ch: number): string {
  if (ch <= 64) return `a${Math.floor((ch - 36) / 16)}`;
  if (ch <= 144) return `b${Math.floor((ch - 100) / 16)}`;
  return `c${Math.floor((ch - 149) / 16)}`;
}

/** How much a network on channel `other` interferes with channel `ch` (0..1). */
export function overlap(band: Band, ch: number, other: number): number {
  if (band === '2.4') {
    if (ch === 14 || other === 14) return ch === other ? 1 : 0;
    return Math.max(0, 1 - Math.abs(ch - other) / 5);
  }
  if (ch === other) return 1;
  // 5 GHz: a neighbour in the same 80 MHz block may share bonded spectrum with us.
  if (band === '5' && block5(ch) === block5(other)) return 0.25;
  return 0;
}

export interface ChannelScore {
  channel: number;
  score: number;
  networks: number;
}

export interface Contributor {
  ssid: string;
  bssid: string;
  channel: number;
  signal_pct: number;
  weight: number;
}

export interface BandAnalysis {
  band: Band;
  occupancy: { channel: number; networks: number; strongest_pct: number }[];
  current_channel: number | null;
  current_score: number | null;
  level: 'low' | 'medium' | 'high' | null;
  candidates: ChannelScore[];
  recommended: ChannelScore | null;
  contributors: Contributor[];
  evidence: string[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function congestionLevel(score: number): 'low' | 'medium' | 'high' {
  return score >= 3 ? 'high' : score >= 1.5 ? 'medium' : 'low';
}

/**
 * Per band: occupancy, a score for each candidate channel (Σ strength × overlap over the other
 * networks heard), and a recommended channel when it is clearly better than the current one
 * (≤ 60 % of the current score and at least 1.0 lower). Ties go to the lower channel number.
 */
export function analyzeChannels(link: WifiLink | null, networks: WifiNet[]): BandAnalysis[] {
  const out: BandAnalysis[] = [];
  const linkBand = link ? bandOf(link) : null;
  for (const band of ['2.4', '5', '6'] as Band[]) {
    const inBand = networks.filter((n) => n.channel !== null && bandOf(n) === band && n.bssid !== link?.bssid);
    const current = link && linkBand === band ? link.channel : null;
    if (!inBand.length && current === null) continue;

    const occ = new Map<number, { networks: number; strongest_pct: number }>();
    for (const n of inBand) {
      const o = occ.get(n.channel!) ?? { networks: 0, strongest_pct: 0 };
      o.networks += 1;
      o.strongest_pct = Math.max(o.strongest_pct, Math.round(strength(n) * 100));
      occ.set(n.channel!, o);
    }
    const scoreOf = (ch: number): ChannelScore => {
      let score = 0;
      let count = 0;
      for (const n of inBand) {
        const f = overlap(band, ch, n.channel!);
        if (f > 0) {
          score += f * strength(n);
          count += 1;
        }
      }
      return { channel: ch, score: round2(score), networks: count };
    };
    const candidates = [...new Set([...CANDIDATES[band], ...(current !== null ? [current] : [])])].sort((a, b) => a - b).map(scoreOf);
    const cur = current !== null ? candidates.find((c) => c.channel === current)! : null;
    const best = [...candidates].filter((c) => CANDIDATES[band].includes(c.channel)).sort((a, b) => a.score - b.score || a.channel - b.channel)[0] ?? null;
    let recommended: ChannelScore | null = null;
    if (cur && best && best.channel !== cur.channel && best.score <= cur.score * 0.6 && cur.score - best.score >= 1) recommended = best;

    const contributors: Contributor[] =
      current === null
        ? []
        : inBand
            .map((n) => ({ ssid: n.ssid, bssid: n.bssid, channel: n.channel!, signal_pct: Math.round(strength(n) * 100), weight: round2(overlap(band, current, n.channel!) * strength(n)) }))
            .filter((c) => c.weight > 0)
            .sort((a, b) => b.weight - a.weight || a.bssid.localeCompare(b.bssid))
            .slice(0, 8);

    const evidence: string[] = [];
    if (cur) {
      evidence.push(`Channel ${cur.channel} (${band} GHz) interference score ${cur.score} from ${cur.networks} other network(s) heard by the collector`);
      for (const c of contributors.slice(0, 5)) evidence.push(`${c.ssid || '(hidden network)'} [${c.bssid}] on channel ${c.channel}, signal ${c.signal_pct}% → weight ${c.weight}`);
      if (recommended) evidence.push(`Channel ${recommended.channel} scores ${recommended.score} (${recommended.networks} overlapping network(s))`);
    }
    out.push({
      band,
      occupancy: [...occ.entries()].map(([channel, o]) => ({ channel, ...o })).sort((a, b) => a.channel - b.channel),
      current_channel: current,
      current_score: cur ? cur.score : null,
      level: cur ? congestionLevel(cur.score) : null,
      candidates,
      recommended,
      contributors,
      evidence,
    });
  }
  return out;
}

// ── findings ──

export interface WifiFinding {
  kind: 'wifi_weak_signal' | 'wifi_low_rate' | 'wifi_congested_channel' | 'wifi_insecure' | 'wifi_evil_twin';
  key: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  evidence: string[];
  details: Record<string, unknown>;
}

export const WEAK_SIGNAL_WARN_DBM = -75;
export const WEAK_SIGNAL_CRIT_DBM = -82;
export const LOW_RATE_MBPS: Record<Band, number> = { '2.4': 20, '5': 50, '6': 50 };

/** Same radio hardware: octets 2–5 equal (vendors derive extra BSSIDs by flipping the first octet's local bit or changing the last octet). */
export function sameHardware(a: string, b: string): boolean {
  const pa = a.toLowerCase().split(/[:-]/);
  const pb = b.toLowerCase().split(/[:-]/);
  return pa.length === 6 && pb.length === 6 && pa.slice(1, 5).join(':') === pb.slice(1, 5).join(':');
}

export interface WifiInput {
  connected: boolean;
  link: WifiLink | null;
  networks: WifiNet[];
  /** BSSIDs an administrator marked as expected for this site (lower-case). */
  expectedBssids: ReadonlySet<string>;
  vendorOf: (mac: string) => string | null;
}

export function analyzeWifi(input: WifiInput): { bands: BandAnalysis[]; findings: WifiFinding[] } {
  const { link } = input;
  const bands = analyzeChannels(link, input.networks);
  const findings: WifiFinding[] = [];
  if (!input.connected || !link) return { bands, findings };
  const band = bandOf(link);
  const name = link.ssid || '(hidden network)';

  const rssi = rssiOf(link);
  if (rssi && rssi.dbm < WEAK_SIGNAL_WARN_DBM) {
    const critical = rssi.dbm < WEAK_SIGNAL_CRIT_DBM;
    findings.push({
      kind: 'wifi_weak_signal',
      key: link.bssid.toLowerCase(),
      severity: critical ? 'critical' : 'warning',
      confidence: rssi.measured ? 'high' : 'medium',
      title: `Weak Wi-Fi signal on "${name}" (${rssi.dbm} dBm)`,
      evidence: [
        rssi.measured ? `Signal ${rssi.dbm} dBm reported by the adapter` : `Signal quality ${link.signal_pct}% reported by the adapter (≈ ${rssi.dbm} dBm)`,
        `Below ${critical ? WEAK_SIGNAL_CRIT_DBM : WEAK_SIGNAL_WARN_DBM} dBm, connections become slow and drop`,
      ],
      details: { ssid: link.ssid, bssid: link.bssid, rssi_dbm: rssi.dbm, rssi_measured: rssi.measured, signal_pct: link.signal_pct, channel: link.channel, band },
    });
  }

  const rates = [link.rx_mbps, link.tx_mbps].filter((v): v is number => v !== null && v !== undefined && v > 0);
  if (band && rates.length) {
    const rate = Math.min(...rates);
    if (rate < LOW_RATE_MBPS[band]) {
      findings.push({
        kind: 'wifi_low_rate',
        key: link.bssid.toLowerCase(),
        severity: 'warning',
        confidence: 'medium',
        title: `Low Wi-Fi link rate on "${name}" (${rate} Mbps)`,
        evidence: [`Negotiated rate ${link.rx_mbps ?? '—'} Mbps receive / ${link.tx_mbps ?? '—'} Mbps transmit on ${band} GHz`, `Below ${LOW_RATE_MBPS[band]} Mbps on ${band} GHz`],
        details: { ssid: link.ssid, bssid: link.bssid, rx_mbps: link.rx_mbps, tx_mbps: link.tx_mbps, band, channel: link.channel },
      });
    }
  }

  const own = bands.find((b) => b.band === band);
  if (own && own.level && own.level !== 'low' && own.current_channel !== null) {
    findings.push({
      kind: 'wifi_congested_channel',
      key: `${band}:${own.current_channel}`,
      severity: own.level === 'high' ? 'warning' : 'info',
      confidence: 'medium',
      title: own.recommended
        ? `Channel ${own.current_channel} is congested — channel ${own.recommended.channel} is clearer`
        : `Channel ${own.current_channel} (${band} GHz) is congested`,
      evidence: own.evidence,
      details: { band, channel: own.current_channel, score: own.current_score, level: own.level, recommended: own.recommended, contributors: own.contributors },
    });
  }

  const ourClass = securityClass(link);
  if (ourClass === 'open' || ourClass === 'wep' || ourClass === 'wpa_tkip') {
    findings.push({
      kind: 'wifi_insecure',
      key: link.ssid || link.bssid.toLowerCase(),
      severity: ourClass === 'wpa_tkip' ? 'warning' : 'critical',
      confidence: 'high',
      title: `"${name}" uses ${SECURITY_LABEL[ourClass]}`,
      evidence: [
        `Authentication "${link.auth ?? link.security ?? '—'}", cipher "${link.cipher ?? '—'}" reported for the network the collector is connected to`,
        ourClass === 'open' ? 'Anyone nearby can join and read unencrypted traffic' : ourClass === 'wep' ? 'WEP can be broken in minutes' : 'WPA/TKIP is deprecated and weak; use WPA2-AES or WPA3',
      ],
      details: { ssid: link.ssid, bssid: link.bssid, security_class: ourClass, auth: link.auth, cipher: link.cipher, security: link.security },
    });
  }

  if (link.ssid) {
    const linkVendor = input.vendorOf(link.bssid);
    for (const n of input.networks) {
      if (n.ssid !== link.ssid || n.bssid.toLowerCase() === link.bssid.toLowerCase()) continue;
      if (input.expectedBssids.has(n.bssid.toLowerCase())) continue;
      const theirClass = securityClass(n);
      const vendor = input.vendorOf(n.bssid);
      const evidence = [
        `"${n.ssid}" is also announced by ${n.bssid} on channel ${n.channel ?? '—'} (signal ${Math.round(strength(n) * 100)}%)`,
        `The collector is connected to ${link.bssid}${linkVendor ? ` (${linkVendor})` : ''} with ${SECURITY_LABEL[ourClass]}`,
      ];
      if (theirClass !== 'unknown' && ourClass !== 'unknown' && theirClass !== ourClass) {
        findings.push({
          kind: 'wifi_evil_twin',
          key: n.bssid.toLowerCase(),
          severity: 'critical',
          confidence: 'medium',
          title: `Possible evil twin: "${n.ssid}" announced with ${SECURITY_LABEL[theirClass]} by ${n.bssid}`,
          evidence: [...evidence, `Its security (${SECURITY_LABEL[theirClass]}) differs from yours (${SECURITY_LABEL[ourClass]})`],
          details: { ssid: n.ssid, bssid: n.bssid, channel: n.channel, their_security: theirClass, our_security: ourClass, vendor, our_bssid: link.bssid, our_vendor: linkVendor, reason: 'different_security' },
        });
        continue;
      }
      if (sameHardware(n.bssid, link.bssid)) continue;
      if (vendor && linkVendor && vendor === linkVendor) continue;
      if (!vendor) {
        findings.push({
          kind: 'wifi_evil_twin',
          key: n.bssid.toLowerCase(),
          severity: 'warning',
          confidence: 'low',
          title: `Unrecognised access point announcing "${n.ssid}" (${n.bssid})`,
          evidence: [...evidence, 'Its BSSID has no registered manufacturer (locally administered or unknown prefix) and does not belong to the access point you are connected to', 'If this is another access point of yours, mark it as expected'],
          details: { ssid: n.ssid, bssid: n.bssid, channel: n.channel, vendor: null, our_bssid: link.bssid, our_vendor: linkVendor, reason: 'unknown_vendor' },
        });
      } else if (linkVendor) {
        findings.push({
          kind: 'wifi_evil_twin',
          key: n.bssid.toLowerCase(),
          severity: 'warning',
          confidence: 'low',
          title: `"${n.ssid}" is also announced by a ${vendor} access point (${n.bssid})`,
          evidence: [...evidence, `Its manufacturer (${vendor}) differs from your access point's (${linkVendor})`, 'If this is another access point of yours, mark it as expected'],
          details: { ssid: n.ssid, bssid: n.bssid, channel: n.channel, vendor, our_bssid: link.bssid, our_vendor: linkVendor, reason: 'different_vendor' },
        });
      }
    }
  }
  return { bands, findings };
}
