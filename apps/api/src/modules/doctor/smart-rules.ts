import type { Diagnosis, EvidenceItem } from '@lan-detective/shared-types';

/**
 * Network Doctor — rules for the collector's smart checks (DHCP and Wi-Fi), same shape and the same
 * design rules as rules.ts: pure functions of their input, every conclusion with evidence, what was
 * ruled out, a confidence with its reason, and concrete next steps. A cause is never stated as certain.
 */

type Core = Omit<Diagnosis, 'engine' | 'generated_at' | 'related_incidents' | 'affected'>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ───────────────────────── DHCP ─────────────────────────

export interface DhcpServerFacts {
  server_id: string;
  source_ip: string | null;
  server_mac: string | null;
  offered_ip: string | null;
  routers: string[];
  dns_servers: string[];
  lease_seconds: number | null;
  expected: 'admin' | 'gateway' | 'baseline' | null;
  first_seen_at: Date;
  last_offer_at: Date | null;
  missed_probes: number;
  clients_choosing: number;
  last_client_choice_at: Date | null;
}

export interface DhcpFacts {
  now: Date;
  /** Servers seen offering within the last few probes (missed_probes < 2) or chosen by clients recently. */
  servers: DhcpServerFacts[];
  probe: { probes: number; last_probe_at: Date | null; consecutive_no_offer: number; listen_errors: string[]; interfaces_probed: number };
  gateways: string[];
}

const EXPECTED_LABEL = { admin: 'approved by an administrator', gateway: "it is the site's gateway", baseline: 'the only DHCP server when monitoring began (not confirmed yet)' } as const;

function describeServer(s: DhcpServerFacts): EvidenceItem {
  const offered = [
    s.offered_ip && `offered ${s.offered_ip}`,
    s.routers.length && `gateway ${s.routers.join(', ')}`,
    s.dns_servers.length && `DNS ${s.dns_servers.join(', ')}`,
    s.lease_seconds !== null && `lease ${Math.round(s.lease_seconds / 60)} min`,
  ]
    .filter(Boolean)
    .join(', ');
  const chosen = s.clients_choosing > 0 ? ` · ${s.clients_choosing} client(s) overheard requesting a lease from it` : '';
  return {
    label: `DHCP server ${s.server_id}${s.server_mac ? ` (${s.server_mac})` : ''}`,
    value: `${s.expected ? `Expected — ${EXPECTED_LABEL[s.expected]}` : 'Not expected'}${offered ? `; ${offered}` : ''}${chosen}`,
    basis: 'observed',
    source: s.last_offer_at ? 'DHCPOFFER in reply to the collector’s DHCPDISCOVER probe' : 'Clients’ DHCPREQUEST overheard by the collector',
    observed_at: iso(s.last_offer_at ?? s.last_client_choice_at),
  };
}

export function diagnoseDhcp(f: DhcpFacts): Core {
  const rogue = f.servers.filter((s) => !s.expected);
  const expected = f.servers.filter((s) => s.expected);
  const probeEvidence: EvidenceItem = {
    label: 'DHCP probes',
    value: `${f.probe.probes} probe(s) so far, ${f.probe.interfaces_probed} interface(s) in authorized ranges probed last time${f.probe.consecutive_no_offer ? `; ${f.probe.consecutive_no_offer} consecutive probe(s) without any offer` : ''}`,
    basis: 'observed',
    source: 'Collector DHCPDISCOVER probe (no lease is ever requested or accepted)',
    observed_at: iso(f.probe.last_probe_at),
  };

  if (rogue.length) {
    const repeated = rogue.some((s) => s.clients_choosing > 0 || (s.last_offer_at && s.first_seen_at.getTime() < s.last_offer_at.getTime() - 60_000));
    const hijack = rogue.some((s) => s.routers.some((r) => !f.gateways.includes(r)) || s.routers.length === 0);
    return {
      rule: 'dhcp-rogue-server',
      fault_domain: 'dhcp',
      title: rogue.length === 1 ? `Unexpected DHCP server ${rogue[0]!.server_id}` : `${rogue.length} unexpected DHCP servers`,
      summary: `A DHCP server that is not the expected one answered the collector's probe${rogue.some((s) => s.clients_choosing) ? ' and clients are taking leases from it' : ''}. Devices that accept its offer get ${hijack ? 'a different gateway or DNS server — their traffic can be cut off or intercepted' : 'addresses from it, which can conflict with the real DHCP server'}.`,
      probable_cause: 'A second DHCP server on the network: a consumer router or access point plugged in on its LAN side, a phone hotspot or virtual machine bridged to the network, a misconfigured server — or a deliberate attack.',
      confidence: repeated ? 'high' : 'medium',
      confidence_reason: repeated
        ? 'The server has answered more than one probe, or clients were overheard requesting leases from it.'
        : 'Seen in a single probe so far; the next probe will confirm it.',
      evidence: [...rogue.map(describeServer), probeEvidence],
      ruled_out: expected.map(describeServer),
      alternatives: ['A second DHCP server that is legitimate (for example a failover pair or a guest network router) — mark it as expected'],
      investigation_steps: [
        'Look up the server’s MAC address in Switch Port Finder to find the switch port it is plugged into',
        'Check what the offered gateway and DNS servers are: anything outside your network is a red flag',
        'Unplug or reconfigure the device (turn its DHCP server off, or plug it in on its WAN port)',
      ],
      recommendations: ['Enable DHCP snooping on managed switches so only trusted ports may answer DHCP', 'If the server is legitimate, mark it as expected so it is not reported again'],
    };
  }

  if (f.probe.consecutive_no_offer >= 2) {
    return {
      rule: 'dhcp-no-offer',
      fault_domain: 'dhcp',
      title: 'No DHCP server is answering',
      summary: `The last ${f.probe.consecutive_no_offer} DHCP probes from the collector got no offer at all. Devices that join or renew now will not get an address.`,
      probable_cause: 'The DHCP server (often the router) is down or its DHCP service stopped, its address pool is exhausted, or a DHCP relay between VLANs is broken.',
      confidence: f.probe.consecutive_no_offer >= 3 ? 'high' : 'medium',
      confidence_reason: `The collector could listen for replies and none came in ${f.probe.consecutive_no_offer} consecutive probes.`,
      evidence: [probeEvidence, ...expected.map(describeServer)],
      ruled_out: [{ label: 'Collector listening', value: 'The DHCP client port was open, so replies would have been received', basis: 'observed', source: 'Collector DHCP probe', observed_at: iso(f.probe.last_probe_at) }],
      alternatives: ['The DHCP server ignores clients it has seen before (unusual)', 'A firewall on the collector host drops incoming DHCP replies'],
      investigation_steps: ['Check the DHCP service on the router or server', 'Check the address pool usage (IPAM shows how full the range is)', 'If the network spans VLANs, check the DHCP relay (ip helper-address)'],
      recommendations: [],
    };
  }

  if (f.probe.probes === 0 || (f.probe.listen_errors.length && f.probe.interfaces_probed === 0)) {
    return {
      rule: 'dhcp-not-measured',
      fault_domain: 'insufficient_data',
      title: f.probe.listen_errors.length ? 'The collector could not listen for DHCP replies' : 'DHCP has not been probed yet',
      summary: f.probe.listen_errors.length
        ? `The collector could not open the DHCP client port: ${f.probe.listen_errors[0]}.`
        : 'The collector probes DHCP every 15 minutes on networks inside the authorized ranges.',
      probable_cause: 'Unknown.',
      confidence: 'low',
      confidence_reason: 'No DHCP reply was observed either way.',
      evidence: [probeEvidence],
      ruled_out: [],
      alternatives: [],
      investigation_steps: f.probe.listen_errors.length
        ? ['On Linux, give the collector CAP_NET_BIND_SERVICE (and CAP_NET_RAW to bind to one interface)', 'On Windows, allow inbound UDP 68 for the collector in the firewall']
        : ['Make sure the collector’s own network is inside an authorized range'],
      recommendations: [],
    };
  }

  return {
    rule: 'dhcp-healthy',
    fault_domain: 'healthy',
    title: 'DHCP is healthy',
    summary: expected.length ? 'Only the expected DHCP server answered.' : 'DHCP answered.',
    probable_cause: 'No fault.',
    confidence: 'high',
    confidence_reason: 'Based on the latest DHCP probe.',
    evidence: [probeEvidence],
    ruled_out: expected.map(describeServer),
    alternatives: [],
    investigation_steps: [],
    recommendations: expected.some((s) => s.expected === 'baseline') ? ['Confirm the DHCP server that was assumed expected when monitoring began.'] : [],
  };
}

// ───────────────────────── Wi-Fi ─────────────────────────

export interface WifiDoctorFacts {
  observed_at: Date;
  collector: string;
  connected: boolean;
  link: {
    ssid: string;
    bssid: string;
    band: '2.4' | '5' | '6' | null;
    channel: number | null;
    rssi_dbm: number | null;
    rssi_measured: boolean;
    signal_pct: number | null;
    rx_mbps: number | null;
    tx_mbps: number | null;
  } | null;
  channel: {
    level: 'low' | 'medium' | 'high' | null;
    score: number | null;
    networks: number;
    recommended: { channel: number; score: number } | null;
    contributors: { ssid: string; bssid: string; channel: number; signal_pct: number; weight: number }[];
  } | null;
}

const WEAK_DBM = -75;
const LOW_RATE: Record<'2.4' | '5' | '6', number> = { '2.4': 20, '5': 50, '6': 50 };

/** Wi-Fi diagnoses for one collector's link: weak signal, congested channel, low PHY rate — or healthy. */
export function diagnoseWifi(f: WifiDoctorFacts): Core[] {
  if (!f.connected || !f.link) return [];
  const l = f.link;
  const name = l.ssid || '(hidden network)';
  const at = iso(f.observed_at);
  const signal: EvidenceItem = {
    label: `Signal from ${name} (${l.bssid})`,
    value:
      l.rssi_dbm === null
        ? 'Not reported'
        : l.rssi_measured
          ? `${l.rssi_dbm} dBm`
          : `${l.signal_pct}% quality (≈ ${l.rssi_dbm} dBm)`,
    basis: 'observed',
    source: `Wi-Fi adapter of collector "${f.collector}"`,
    observed_at: at,
  };
  const rates = [l.rx_mbps, l.tx_mbps].filter((v): v is number => v !== null && v > 0);
  const rate = rates.length ? Math.min(...rates) : null;
  const rateItem: EvidenceItem = { label: 'Link rate', value: `${l.rx_mbps ?? '—'} Mbps receive / ${l.tx_mbps ?? '—'} Mbps transmit${l.band ? ` on ${l.band} GHz channel ${l.channel ?? '—'}` : ''}`, basis: 'observed', source: `Wi-Fi adapter of collector "${f.collector}"`, observed_at: at };
  const ch = f.channel;
  const chanItem: EvidenceItem | null =
    ch && ch.score !== null
      ? { label: `Channel ${l.channel} occupancy`, value: `Interference score ${ch.score} (${ch.level}) from ${ch.networks} other network(s)`, basis: 'derived', source: 'Nearby networks in the collector’s Wi-Fi scan', observed_at: at }
      : null;
  const weak = l.rssi_dbm !== null && l.rssi_dbm < WEAK_DBM;
  const congested = ch?.level === 'high' || ch?.level === 'medium';
  const lowRate = rate !== null && l.band !== null && rate < LOW_RATE[l.band];
  const out: Core[] = [];

  if (weak) {
    out.push({
      rule: 'wifi-weak-signal',
      fault_domain: 'wifi',
      title: `Weak Wi-Fi signal at collector "${f.collector}"`,
      summary: `The collector receives "${name}" at ${l.rssi_dbm} dBm. Below about ${WEAK_DBM} dBm throughput drops and connections become unreliable.`,
      probable_cause: 'Too much distance or walls between this spot and the access point, or the access point’s transmit power is low.',
      confidence: l.rssi_measured ? 'high' : 'medium',
      confidence_reason: l.rssi_measured ? 'Signal strength reported in dBm by the adapter.' : 'Derived from the adapter’s quality percentage, which is an approximation.',
      evidence: [signal, ...(lowRate ? [rateItem] : [])],
      ruled_out: chanItem && !congested ? [chanItem] : [],
      alternatives: ['The adapter’s antenna is weak or obstructed (a USB dongle behind the PC)'],
      investigation_steps: ['Move the access point closer or add one (or a mesh node) near this location', 'Check that the access point is not hidden in a cabinet or behind metal', 'Prefer a cable for fixed equipment'],
      recommendations: [],
    });
  }
  if (congested && ch) {
    out.push({
      rule: 'wifi-congested-channel',
      fault_domain: 'wifi',
      title: ch.recommended ? `Wi-Fi channel ${l.channel} is congested — channel ${ch.recommended.channel} is clearer` : `Wi-Fi channel ${l.channel} is congested`,
      summary: `${ch.networks} other network(s) are heard on or overlapping channel ${l.channel} at the collector's location.${ch.recommended ? ` Channel ${ch.recommended.channel} scores ${ch.recommended.score} against ${ch.score} now.` : ' No clearly better standard channel was found.'}`,
      probable_cause: 'Neighbouring networks share the airtime of this channel, so every device waits longer to transmit.',
      confidence: 'medium',
      confidence_reason: 'Based on the networks heard by the collector only; other spots of the site may hear different neighbours.',
      evidence: [...(chanItem ? [chanItem] : []), ...ch.contributors.slice(0, 5).map((c) => ({ label: `${c.ssid || '(hidden network)'} [${c.bssid}]`, value: `Channel ${c.channel}, signal ${c.signal_pct}% → weight ${c.weight}`, basis: 'observed' as const, source: 'Collector Wi-Fi scan', observed_at: at }))],
      ruled_out: weak ? [] : [signal],
      alternatives: ['Non-Wi-Fi interference (microwave ovens, Bluetooth, cordless phones) on 2.4 GHz is not visible in a scan'],
      investigation_steps: ch.recommended ? [`Set the access point to channel ${ch.recommended.channel} (in its Wi-Fi settings) and compare`] : ['Prefer 5 GHz for devices that support it'],
      recommendations: l.band === '2.4' ? ['Use 20 MHz channel width on 2.4 GHz and only channels 1, 6 or 11'] : [],
    });
  }
  if (lowRate && !weak) {
    out.push({
      rule: 'wifi-low-phy-rate',
      fault_domain: 'wifi',
      title: `Low Wi-Fi link rate at collector "${f.collector}" (${rate} Mbps)`,
      summary: `The adapter negotiated only ${rate} Mbps although the signal is ${l.rssi_dbm === null ? 'not reported' : 'adequate'}.`,
      probable_cause: congested ? 'Channel congestion forces lower rates.' : 'An old Wi-Fi standard or narrow channel in use, a legacy-mode setting on the access point, or interference.',
      confidence: 'low',
      confidence_reason: 'The link rate changes from moment to moment; this is one sample.',
      evidence: [rateItem, ...(congested && chanItem ? [chanItem] : [])],
      ruled_out: [signal],
      alternatives: ['The adapter was idle and stepped its rate down to save power'],
      investigation_steps: ['Check that the access point allows Wi-Fi 5/6 rates (no “legacy” or “b/g only” mode)', 'Check the channel width setting'],
      recommendations: [],
    });
  }
  if (!out.length) {
    out.push({
      rule: 'wifi-healthy',
      fault_domain: 'healthy',
      title: `Wi-Fi at collector "${f.collector}" is healthy`,
      summary: `Signal, channel occupancy and link rate of "${name}" are within normal limits.`,
      probable_cause: 'No fault.',
      confidence: 'medium',
      confidence_reason: 'Measured at the collector’s location only.',
      evidence: [],
      ruled_out: [signal, rateItem, ...(chanItem ? [chanItem] : [])],
      alternatives: [],
      investigation_steps: [],
      recommendations: [],
    });
  }
  return out;
}
