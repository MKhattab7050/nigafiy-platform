import type { CheckRole, CheckState, Confidence, Diagnosis, EvidenceItem, FaultDomain } from '@lan-detective/shared-types';

/**
 * Network Doctor — deterministic rule engine (rules-v1).
 *
 * Input: measurements the collector already made (check states and samples, device status,
 * collector heartbeat). Output: the most probable fault domain, WITH the evidence, what was ruled
 * out, how confident the rule is and why, and what to check next.
 *
 * Design rules:
 *  - pure function of its input: same observations → same diagnosis, and it can be unit-tested;
 *  - a cause is never stated as certain; confidence is 'high' only when independent measurements agree;
 *  - when the data cannot separate two causes, both are listed (alternatives).
 */
export const ENGINE = 'rules-v1';

export interface CheckFacts {
  id: string;
  name: string;
  kind: 'icmp' | 'tcp' | 'dns';
  role: CheckRole;
  target: string;
  port: number | null;
  state: CheckState;
  last_result_at: Date | null;
  last_latency_ms: number | null;
  last_loss_pct: number | null;
  last_error: string | null;
  last_resolved_target: string | null;
  latency_warn_ms: number | null;
  /** Last 15 minutes. */
  recent_samples: number;
  recent_ok: number;
  recent_latency_ms: number | null;
  recent_loss_pct: number | null;
  /** Average latency of successful samples over the previous 7 days (excluding the last hour). */
  baseline_latency_ms: number | null;
  baseline_samples: number;
}

export interface NetworkFacts {
  now: Date;
  checks: CheckFacts[];
  collectors: { total: number; online: number; last_heartbeat_at: Date | null };
  devices: { total: number; offline: number; went_offline_recently: number };
  recent_changes: { type: string; title: string; occurred_at: Date }[];
}

type Core = Omit<Diagnosis, 'engine' | 'generated_at' | 'related_incidents' | 'affected'>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const fmtMs = (v: number | null) => (v === null ? 'n/a' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const fmtPct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)}%`);
const targetOf = (c: CheckFacts) => (c.target === 'auto:gateway' ? (c.last_resolved_target ?? 'default gateway') : c.target) + (c.port ? `:${c.port}` : '');

function describe(c: CheckFacts): EvidenceItem {
  const window = c.recent_samples ? ` · last 15 min: ${c.recent_ok}/${c.recent_samples} samples succeeded` : '';
  let value: string;
  if (c.state === 'down') value = `Not responding (${c.last_error ?? 'no reply'})${window}`;
  else if (c.state === 'degraded') {
    const base = c.baseline_latency_ms !== null && c.baseline_samples >= 20 ? `, 7-day baseline ${fmtMs(c.baseline_latency_ms)}` : '';
    value = `Responding but degraded: latency ${fmtMs(c.last_latency_ms)}${c.kind === 'icmp' ? `, loss ${fmtPct(c.last_loss_pct)}` : ''}${base}${window}`;
  } else if (c.state === 'ok') value = `Healthy: latency ${fmtMs(c.last_latency_ms)}${c.kind === 'icmp' ? `, loss ${fmtPct(c.last_loss_pct)}` : ''}${window}`;
  else value = 'No measurements yet';
  return { label: `${c.name} → ${targetOf(c)}`, value, basis: 'observed', source: `${c.kind.toUpperCase()} check from the site collector`, observed_at: iso(c.last_result_at) };
}

const worst = (states: CheckState[]): CheckState => (['down', 'degraded', 'ok', 'unknown'] as const).find((s) => states.includes(s)) ?? 'unknown';

function changeNotes(f: NetworkFacts): EvidenceItem[] {
  return f.recent_changes.slice(0, 5).map((c) => ({
    label: 'Recent change',
    value: c.title,
    basis: 'observed' as const,
    source: 'Event timeline (2 hours before now)',
    observed_at: iso(c.occurred_at),
  }));
}

/** Diagnose the gateway → internet → DNS path of one site. */
export function diagnoseNetwork(f: NetworkFacts): Core {
  const by = (role: CheckRole) => f.checks.filter((c) => c.role === role && c.state !== 'unknown');
  const gateway = by('gateway');
  const internet = by('internet');
  const dns = by('dns');
  const G = worst(gateway.map((c) => c.state));
  const I = worst(internet.map((c) => c.state));
  const D = worst(dns.map((c) => c.state));
  const internetDown = internet.filter((c) => c.state === 'down');
  const all = [...gateway, ...internet, ...dns];
  const bad = all.filter((c) => c.state === 'down' || c.state === 'degraded');
  const good = all.filter((c) => c.state === 'ok');
  const ev = (list: CheckFacts[]) => list.map(describe);
  const manyDevicesLost = f.devices.total >= 4 && f.devices.went_offline_recently >= Math.max(3, Math.ceil(f.devices.total * 0.3));

  const base = { evidence: [...ev(bad)], ruled_out: ev(good), alternatives: [] as string[] };

  if (f.collectors.total > 0 && f.collectors.online === 0) {
    return {
      rule: 'no-observer',
      fault_domain: 'insufficient_data',
      title: 'No collector is reporting from this site',
      summary: 'The network cannot be diagnosed right now because no collector at this site is in contact with the cloud. Check states shown are the last ones received.',
      probable_cause: 'Unknown — there is no current observation.',
      confidence: 'low',
      confidence_reason: 'Without a reporting collector there are no current measurements.',
      evidence: [{ label: 'Collectors reporting', value: `0 of ${f.collectors.total}`, basis: 'observed', source: 'Collector heartbeat', observed_at: iso(f.collectors.last_heartbeat_at) }],
      ruled_out: [],
      alternatives: ['The site lost its internet connection', 'The collector host is off or the collector service stopped'],
      investigation_steps: ['Check whether the site has internet access', 'Check that the collector host is powered on and the collector service is running'],
      recommendations: ['Once the collector reconnects it uploads what it measured while disconnected; re-run the diagnosis then.'],
    };
  }

  if (!gateway.length || !internet.length) {
    return {
      rule: 'missing-path-checks',
      fault_domain: 'insufficient_data',
      title: 'Not enough measurements to diagnose',
      summary: 'Locating a fault needs at least one gateway check and one internet check with results.',
      probable_cause: 'Unknown.',
      confidence: 'low',
      confidence_reason: `Results available: ${gateway.length} gateway check(s), ${internet.length} internet check(s).`,
      ...base,
      investigation_steps: ['Make sure a collector is enrolled and online at this site', 'Keep the default gateway and internet checks enabled under Live Monitoring'],
      recommendations: [],
    };
  }

  // 1. Gateway unreachable.
  if (G === 'down') {
    const lanWide = manyDevicesLost;
    return {
      rule: lanWide ? 'gateway-down-and-devices-lost' : 'gateway-down',
      fault_domain: lanWide ? 'lan_segment' : 'local_gateway',
      title: lanWide ? 'Local network segment failure' : 'Local gateway is not responding',
      summary: lanWide
        ? `The collector cannot reach the default gateway and ${f.devices.went_offline_recently} devices stopped responding at about the same time. The fault is inside the local network, not at the ISP.`
        : 'The collector cannot reach the default gateway. Internet and DNS failures are a consequence of that — the fault is inside the local network, not at the ISP.',
      probable_cause: lanWide
        ? 'A switch, its uplink, or the part of the LAN the collector is connected to has failed or lost power.'
        : 'The router/firewall acting as default gateway is down, restarting, or unreachable from the collector.',
      confidence: I === 'down' ? 'high' : 'medium',
      confidence_reason:
        I === 'down'
          ? 'Gateway and every internet target fail together, which is what a local failure produces.'
          : 'The gateway does not answer but internet targets still do — the gateway may simply be dropping ICMP.',
      evidence: [
        ...ev(bad),
        ...(lanWide
          ? [{ label: 'Devices that stopped responding in the last 30 min', value: `${f.devices.went_offline_recently} of ${f.devices.total}`, basis: 'observed' as const, source: 'Discovery sweeps', observed_at: iso(f.now) }]
          : []),
        ...changeNotes(f),
      ],
      ruled_out: ev(good),
      alternatives: lanWide
        ? ['The gateway itself failed and happens to be the switch as well (all-in-one router)']
        : ["Only the collector's own cable/switch port/Wi-Fi link is down", ...(I !== 'down' ? ['The gateway ignores ICMP echo (then this check should be changed to a TCP check)'] : [])],
      investigation_steps: [
        'Check that the router/firewall is powered and its LAN link lights are on',
        'From another computer on the same network, ping the gateway address',
        "Check the switch port and cable of the collector's host",
        ...(lanWide ? ['Check power and uplink of the access switch the affected devices share'] : []),
      ],
      recommendations: ['Do not call the ISP yet: the failure is before the WAN link.', 'If the gateway was just restarted or updated, wait for it to finish booting and watch for recovery.'],
    };
  }

  // 2. Gateway fine, internet unreachable.
  if (I === 'down' && internetDown.length === internet.length) {
    return {
      rule: 'gateway-ok-internet-down',
      fault_domain: 'wan_isp',
      title: 'Internet connection is down (WAN / ISP)',
      summary: `The local gateway answers normally but ${internet.length === 1 ? 'the internet target does' : `all ${internet.length} independent internet targets do`} not. The local network is working; the fault is on the WAN side.`,
      probable_cause: "The WAN link, the ISP, or the gateway's WAN interface/modem is down.",
      confidence: internet.length >= 2 ? 'high' : 'medium',
      confidence_reason:
        internet.length >= 2
          ? `${internet.length} independent internet targets fail while the gateway responds (${fmtMs(gateway[0]!.last_latency_ms)}).`
          : 'Only one internet target is configured; it alone cannot distinguish an ISP outage from that one destination being down.',
      evidence: [...ev(internetDown), ...ev(dns.filter((c) => c.state !== 'ok')), ...changeNotes(f)],
      ruled_out: ev(gateway),
      alternatives: ['Outbound ICMP is blocked by a newly changed firewall rule', ...(internet.length < 2 ? ['The single internet target itself is unreachable'] : [])],
      investigation_steps: [
        'Check the WAN/Internet status light of the router and modem (ONT)',
        "Open the router's status page and check whether the WAN interface has an IP address",
        'Check with the ISP for a reported outage in the area',
        'Review recent firewall rule changes',
      ],
      recommendations: ['Restart the modem/ONT, then the router, if the WAN interface shows no link.', "Contact the ISP with the outage start time shown on this incident's timeline."],
    };
  }

  // 3. Some internet targets fail, others work.
  if (I === 'down') {
    return {
      rule: 'partial-internet',
      fault_domain: 'remote_target',
      title: 'One internet destination is unreachable',
      summary: `${internetDown.length} of ${internet.length} internet targets do not respond while the others do. General internet connectivity works.`,
      probable_cause: 'The specific destination (or the route to it) has a problem; this is outside the local network.',
      confidence: 'medium',
      confidence_reason: 'Other internet targets are reachable through the same gateway and WAN link.',
      evidence: ev(internetDown),
      ruled_out: [...ev(gateway), ...ev(internet.filter((c) => c.state === 'ok'))],
      alternatives: ['A firewall rule blocks only this destination', 'A routing problem at the ISP affects only some networks'],
      investigation_steps: ['Check whether users actually have a problem — this may only affect the monitored target', 'Run a traceroute to the failing destination to see where it stops'],
      recommendations: ['If it persists while nothing else is affected, replace this target with another well-known address.'],
    };
  }

  // 4. Connectivity fine, DNS failing or slow.
  if (D === 'down' || D === 'degraded') {
    const failing = dns.filter((c) => c.state !== 'ok');
    const nx = failing.some((c) => /does not resolve|no such host|nxdomain/i.test(c.last_error ?? ''));
    return {
      rule: D === 'down' ? 'dns-down' : 'dns-slow',
      fault_domain: 'dns',
      title: D === 'down' ? 'DNS resolution is failing' : 'DNS resolution is slow',
      summary: `The gateway and internet targets respond normally by IP address, but name resolution ${D === 'down' ? 'fails' : 'is slower than its threshold'}. Users experience this as "the internet is down/slow" although connectivity is fine.`,
      probable_cause: nx ? 'The resolver answers but cannot resolve the name — its forwarder/upstream DNS is misconfigured or unreachable.' : 'The DNS server used by this network is not answering, is overloaded, or its upstream forwarder is unreachable.',
      confidence: I === 'ok' ? 'high' : 'medium',
      confidence_reason: I === 'ok' ? 'Reaching internet addresses directly works at the same time as resolution fails.' : 'Internet targets are themselves degraded, which may be slowing DNS.',
      evidence: ev(failing),
      ruled_out: [...ev(gateway), ...ev(internet.filter((c) => c.state === 'ok'))],
      alternatives: ['Outbound DNS (port 53) is blocked by a firewall change'],
      investigation_steps: [
        "Find which DNS server the network hands out (DHCP settings) — the check uses the collector host's configured resolver",
        'Query that server directly, and query a public resolver (for example 1.1.1.1) to compare',
        "Check the DNS server's forwarder configuration and whether the DNS service is running",
      ],
      recommendations: ['If the internal DNS server is down, restart its DNS service or temporarily point DHCP at a working resolver.'],
    };
  }

  // 5. Local path degraded.
  if (G === 'degraded') {
    const g = gateway.find((c) => c.state === 'degraded')!;
    return {
      rule: 'gateway-degraded',
      fault_domain: 'lan_quality',
      title: 'Local network path is degraded',
      summary: `Traffic between the collector and the default gateway shows ${g.last_loss_pct ? `${fmtPct(g.last_loss_pct)} packet loss` : `high latency (${fmtMs(g.last_latency_ms)})`}. This hop is entirely inside the local network, so the slowness users see starts here.`,
      probable_cause: 'A local problem: a bad cable or switch port, Wi-Fi interference if the path is wireless, a network loop/broadcast storm, or an overloaded gateway.',
      confidence: 'medium',
      confidence_reason: 'The gateway is one local hop away; loss or delay there cannot be caused by the ISP. Which local component is at fault cannot be told without switch port statistics (SNMP, planned).',
      evidence: [...ev(bad), ...changeNotes(f)],
      ruled_out: ev(good),
      alternatives: ['The gateway deprioritises ICMP when its CPU is busy (then real traffic may be less affected)'],
      investigation_steps: ['Check CPU/load on the router or firewall', "Check the cable and switch port of the collector's host, and the port's error counters if the switch is managed", 'Look for a device generating unusually heavy traffic'],
      recommendations: ['If the collector is on Wi-Fi, connect it by cable so it measures the wired network.'],
    };
  }

  // 6. Internet quality.
  if (I === 'degraded') {
    const degraded = internet.filter((c) => c.state === 'degraded');
    const withBaseline = degraded.find((c) => c.baseline_latency_ms !== null && c.baseline_samples >= 20);
    return {
      rule: 'internet-degraded',
      fault_domain: 'wan_quality',
      title: 'Internet connection is slow or lossy',
      summary: `The local gateway responds normally (${fmtMs(gateway[0]!.last_latency_ms)}) but ${degraded.length} of ${internet.length} internet targets are above their latency/loss thresholds${withBaseline ? ` (now ${fmtMs(withBaseline.last_latency_ms)}, 7-day baseline ${fmtMs(withBaseline.baseline_latency_ms)})` : ''}.`,
      probable_cause: 'The WAN link is congested or impaired: either the uplink is saturated by local traffic, or the ISP has a quality problem.',
      confidence: degraded.length === internet.length && internet.length >= 2 ? 'medium' : 'low',
      confidence_reason:
        degraded.length === internet.length && internet.length >= 2
          ? 'All internet targets are affected while the local hop is clean; saturation and ISP trouble look identical from here without bandwidth data.'
          : 'Only some targets are affected; this may be specific to those destinations.',
      evidence: ev(degraded),
      ruled_out: [...ev(gateway), ...ev(internet.filter((c) => c.state === 'ok'))],
      alternatives: ['A large upload/download or backup is saturating the uplink', 'ISP congestion at peak hours'],
      investigation_steps: ["Check the router's WAN bandwidth usage for a saturating device or transfer", 'Compare with the same hour on previous days in Time Machine', 'Run a speed test from a wired computer'],
      recommendations: ['If it repeats at the same hours, raise it with the ISP using the charts as evidence.'],
    };
  }

  return {
    rule: 'all-healthy',
    fault_domain: 'healthy',
    title: 'No network path problem detected',
    summary: 'The default gateway, internet targets and DNS resolution are all responding within their thresholds.',
    probable_cause: 'None — measurements are normal.',
    confidence: 'high',
    confidence_reason: `All ${all.length} path checks are healthy.`,
    evidence: [],
    ruled_out: ev(good),
    alternatives: [],
    investigation_steps: ['If users still report a problem, it is likely specific to one device, application or Wi-Fi area — check that device under Devices.'],
    recommendations: [],
  };
}

export interface ServiceFacts {
  check: CheckFacts;
  /** The inventory device whose current IP equals the check target (if any). */
  host: { name: string; status: 'online' | 'offline' | 'unknown'; last_seen_at: Date } | null;
  network: FaultDomain;
}

export function diagnoseService(f: ServiceFacts): Core {
  const c = f.check;
  const evidence = [describe(c)];
  const error = (c.last_error ?? '').toLowerCase();
  if (f.network !== 'healthy' && f.network !== 'insufficient_data') {
    return {
      rule: 'service-during-network-fault',
      fault_domain: 'service',
      title: `${c.name}: unreachable during a wider network problem`,
      summary: 'This service check is failing while the site also has a network path problem. The service itself may be fine.',
      probable_cause: 'Most likely a consequence of the network problem rather than a fault of the service.',
      confidence: 'low',
      confidence_reason: 'A separate network fault is active; the two cannot be separated until it clears.',
      evidence,
      ruled_out: [],
      alternatives: ['The service failed independently at the same time'],
      investigation_steps: ['Resolve the network incident first, then see whether this check recovers'],
      recommendations: [],
    };
  }
  if (f.host && f.host.status === 'offline') {
    return {
      rule: 'service-host-offline',
      fault_domain: 'service_host',
      title: `${c.name}: the host is offline`,
      summary: `The device at ${targetOf(c)} (${f.host.name}) stopped responding to discovery as well, so the whole host is unreachable — not just this service.`,
      probable_cause: 'The server/device is powered off, crashed, or disconnected from the network.',
      confidence: 'high',
      confidence_reason: 'Two independent observations agree: the service check fails and discovery no longer sees the host.',
      evidence: [...evidence, { label: `Host ${f.host.name}`, value: 'Offline in discovery sweeps', basis: 'observed', source: 'Discovery (ICMP + neighbour table)', observed_at: iso(f.host.last_seen_at) }],
      ruled_out: [],
      alternatives: [],
      investigation_steps: ['Check power and network cable of the host', 'Check its console or hypervisor for a crash or shutdown'],
      recommendations: [],
    };
  }
  const hostUp: EvidenceItem[] = f.host ? [{ label: `Host ${f.host.name}`, value: 'Online in discovery sweeps', basis: 'observed', source: 'Discovery (ICMP + neighbour table)', observed_at: iso(f.host.last_seen_at) }] : [];
  if (c.kind === 'tcp' && /refused/.test(error)) {
    return {
      rule: 'service-port-refused',
      fault_domain: 'service',
      title: `${c.name}: service is not listening`,
      summary: `The host answered the connection attempt to port ${c.port} with a refusal. The machine is up and reachable, but nothing is accepting connections on that port.`,
      probable_cause: 'The service process is stopped or crashed (or is listening on a different port/interface).',
      confidence: 'high',
      confidence_reason: 'An active refusal (TCP RST) can only come from a reachable host with no listener on the port.',
      evidence,
      ruled_out: hostUp,
      alternatives: ['A host firewall is configured to reject (not drop) the connection'],
      investigation_steps: ['Check the service status on the host and its logs', 'Confirm which port and address the service is configured to listen on'],
      recommendations: ['Restart the service after reading its log for the reason it stopped.'],
    };
  }
  if (/does not resolve|no such host/.test(error)) {
    return {
      rule: 'service-name-unresolved',
      fault_domain: 'dns',
      title: `${c.name}: target name does not resolve`,
      summary: `The name ${c.target} could not be resolved by the collector host's DNS resolver, so the service was never contacted.`,
      probable_cause: 'A missing or wrong DNS record for this name, or an internal DNS server problem.',
      confidence: 'medium',
      confidence_reason: 'The failure happened at name resolution, before any connection attempt.',
      evidence,
      ruled_out: [],
      alternatives: [],
      investigation_steps: ['Check the DNS record for this name on the internal DNS server'],
      recommendations: [],
    };
  }
  return {
    rule: 'service-unresponsive',
    fault_domain: 'service',
    title: `${c.name}: not responding`,
    summary: `Connections to ${targetOf(c)} get no answer${f.host ? ', although the host itself is still seen on the network' : ''}.`,
    probable_cause: f.host ? 'A firewall is dropping the connection, or the service is hung.' : 'The host is down or unreachable, or a firewall is dropping the connection.',
    confidence: f.host ? 'medium' : 'low',
    confidence_reason: f.host ? 'The host is online in discovery, which narrows it to the service or a filter in between.' : 'The target is not a device in the inventory, so host state is unknown.',
    evidence,
    ruled_out: hostUp,
    alternatives: f.host ? [] : ['The host is powered off'],
    investigation_steps: ['Check the service status on the host', 'Check host and network firewall rules for this port', ...(f.host ? [] : ['Add the network of this host as an authorized scope so its availability is tracked'])],
    recommendations: [],
  };
}

export function diagnoseDevice(f: { name: string; ip: string | null; last_seen_at: Date; missed: number; network: FaultDomain; devices: NetworkFacts['devices'] }): Core {
  const evidence: EvidenceItem[] = [
    { label: `${f.name}${f.ip ? ` (${f.ip})` : ''}`, value: `No ICMP reply and no reachable neighbour entry in ${f.missed} consecutive sweeps`, basis: 'observed', source: 'Discovery sweeps', observed_at: iso(f.last_seen_at) },
  ];
  const wide = f.devices.total >= 4 && f.devices.went_offline_recently >= Math.max(3, Math.ceil(f.devices.total * 0.3));
  if (wide || (f.network !== 'healthy' && f.network !== 'insufficient_data')) {
    return {
      rule: 'device-during-wider-fault',
      fault_domain: 'lan_segment',
      title: `${f.name} is offline — part of a wider problem`,
      summary: wide ? `${f.devices.went_offline_recently} of ${f.devices.total} devices stopped responding around the same time.` : 'The site also has an active network path problem.',
      probable_cause: 'A shared cause (switch, power, or the network path) rather than this device alone.',
      confidence: 'medium',
      confidence_reason: 'Several things failed together.',
      evidence: [...evidence, { label: 'Devices that stopped responding in the last 30 min', value: `${f.devices.went_offline_recently} of ${f.devices.total}`, basis: 'observed', source: 'Discovery sweeps', observed_at: null }],
      ruled_out: [],
      alternatives: [],
      investigation_steps: ['Find what the affected devices have in common: switch, power circuit, room'],
      recommendations: [],
    };
  }
  return {
    rule: 'device-alone-offline',
    fault_domain: 'device',
    title: `${f.name} is offline`,
    summary: 'This critical device stopped responding while the rest of the network is healthy.',
    probable_cause: 'A problem with this device itself: power, crash, cable, or its switch port.',
    confidence: 'medium',
    confidence_reason: 'Other devices and the network path are fine, which isolates the problem to this device or its link. A device that blocks both ICMP and ARP from the collector would look the same.',
    evidence,
    ruled_out: [{ label: 'Rest of the network', value: `${f.devices.total - f.devices.offline} of ${f.devices.total} devices online; gateway/internet healthy`, basis: 'derived', source: 'Discovery sweeps and path checks', observed_at: null }],
    alternatives: ['The device changed IP address and identity could not follow it (no MAC visible)'],
    investigation_steps: ['Check power and link lights on the device', 'Check its switch port and cable', 'Check its console for a crash or reboot loop'],
    recommendations: [],
  };
}

export function diagnoseCollector(f: { name: string; last_heartbeat_at: Date | null; online: boolean; during: { samples: number; internet_failed: number; gateway_failed: number } }): Core {
  const hb: EvidenceItem = { label: `Collector "${f.name}"`, value: f.online ? 'Reporting again' : 'No heartbeat', basis: 'observed', source: 'Collector heartbeat', observed_at: iso(f.last_heartbeat_at) };
  // After reconnecting, the collector uploads what it measured while cut off — that settles the cause.
  if (f.during.samples >= 3) {
    const internetLost = f.during.internet_failed > 0;
    const gatewayLost = f.during.gateway_failed > 0;
    if (internetLost) {
      return {
        rule: 'collector-gap-explained',
        fault_domain: 'site_internet',
        title: gatewayLost ? 'Site lost its local gateway — collector was cut off' : 'Site lost its internet connection — collector was cut off',
        summary: `The collector kept measuring while it could not reach the cloud and uploaded the results afterwards: internet checks failed ${f.during.internet_failed} times${gatewayLost ? ` and gateway checks ${f.during.gateway_failed} times` : ' while the gateway kept responding'}.`,
        probable_cause: gatewayLost ? 'The local gateway was down, which also cut the collector off from the cloud.' : 'A WAN/ISP outage at the site.',
        confidence: 'high',
        confidence_reason: "Based on the collector's own buffered measurements from the period it was out of contact.",
        evidence: [hb, { label: 'Buffered measurements from the gap', value: `${f.during.samples} samples; internet failures ${f.during.internet_failed}, gateway failures ${f.during.gateway_failed}`, basis: 'observed', source: 'Collector spool, uploaded after reconnect', observed_at: null }],
        ruled_out: [{ label: 'Collector host', value: 'Was running and measuring throughout', basis: 'derived', source: 'Presence of buffered samples', observed_at: null }],
        alternatives: [],
        investigation_steps: ['See the network incident for the same period for the path-level diagnosis'],
        recommendations: [],
      };
    }
    return {
      rule: 'collector-gap-cloud-only',
      fault_domain: 'collector',
      title: 'Collector could not reach the cloud although the site had internet',
      summary: `During the gap the collector's own internet checks kept succeeding (${f.during.samples} samples), so the site was online; only the connection to LAN Detective failed.`,
      probable_cause: 'Outbound HTTPS to the LAN Detective cloud was blocked or failing (firewall/proxy change, TLS inspection, DNS for the cloud hostname).',
      confidence: 'medium',
      confidence_reason: 'Buffered measurements show working internet during the gap.',
      evidence: [hb],
      ruled_out: [{ label: 'Site internet', value: 'Working during the gap', basis: 'observed', source: 'Collector spool, uploaded after reconnect', observed_at: null }],
      alternatives: ['A LAN Detective platform outage'],
      investigation_steps: ['Check firewall/proxy rules for outbound HTTPS from the collector host'],
      recommendations: [],
    };
  }
  if (f.online) {
    return {
      rule: 'collector-not-measuring',
      fault_domain: 'collector',
      title: `Collector "${f.name}" was not running`,
      summary: 'The collector is back, and it uploaded no measurements from the period it was out of contact. A running collector keeps measuring and buffers its results, so it was not running during that time.',
      probable_cause: 'The collector host was powered off or restarting, or the collector service was stopped.',
      confidence: 'medium',
      confidence_reason: 'Absence of buffered measurements for the gap. (If the local buffer was full or erased the same picture would result.)',
      evidence: [hb, { label: 'Buffered measurements from the gap', value: `${f.during.samples}`, basis: 'observed', source: 'Telemetry received after reconnect', observed_at: null }],
      ruled_out: [],
      alternatives: ['The collector state directory (buffer) was deleted'],
      investigation_steps: ['Check the uptime of the collector host and the service logs around the gap'],
      recommendations: ['Run the collector as a service with automatic restart (systemd unit or Docker restart policy).'],
    };
  }
  return {
    rule: 'collector-silent',
    fault_domain: 'collector',
    title: `Collector "${f.name}" lost contact`,
    summary: 'The cloud stopped receiving heartbeats from this collector. From the cloud side the possible causes cannot be told apart; device states at the site are shown as unknown, not offline.',
    probable_cause: 'Undetermined until the collector reconnects.',
    confidence: 'low',
    confidence_reason: 'There is no observation from inside the site right now.',
    evidence: [hb],
    ruled_out: [],
    alternatives: ['The site lost its internet connection', 'The collector host is powered off or restarting', 'The collector service stopped', 'Outbound HTTPS from the collector is blocked'],
    investigation_steps: ['Ask someone on site whether internet access works', 'Check that the collector host is on and the service is running (`systemctl status lan-collector` / `docker ps`)'],
    recommendations: ['When the collector reconnects it uploads its buffered measurements and this diagnosis is refined automatically.'],
  };
}

export function finalize(core: Core, affected: Diagnosis['affected'], related: Diagnosis['related_incidents'], now: Date): Diagnosis {
  return { engine: ENGINE, ...core, affected, related_incidents: related, generated_at: now.toISOString() };
}

export type { Confidence };
