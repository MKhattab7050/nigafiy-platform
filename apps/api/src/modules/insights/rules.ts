import type { Insight, InsightAction, InsightsReport, Severity } from '@nigafiy/shared-types';

/**
 * Smart insights: deterministic rules over facts already stored by Nigafiy.
 * Every insight states what was observed (evidence) and offers the next step as an action.
 * Nothing here guesses beyond the data; where a cause is uncertain the text says so.
 */
export interface DeviceFact {
  id: string;
  label: string;
  ip: string | null;
  status: 'online' | 'offline' | 'unknown';
  trust: 'unreviewed' | 'known' | 'unwanted';
  is_critical: boolean;
  mac_randomized: boolean;
  named: boolean;
  monitored: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
}

/** Device types worth a monitoring check of their own: the network's infrastructure. */
export const INFRASTRUCTURE_TYPES = ['router', 'printer', 'nas', 'camera', 'access_point', 'server'] as const;

/** At most this many infrastructure devices are read and listed per request (the count stays exact). */
export const INFRASTRUCTURE_LIMIT = 200;

/** An infrastructure device whose type Nigafiy inferred (medium/high confidence) and that has no check. */
export interface InfrastructureFact {
  id: string;
  label: string;
  ip: string;
  device_type: (typeof INFRASTRUCTURE_TYPES)[number];
  type_confidence: 'medium' | 'high';
  type_evidence: string | null;
}

export interface InsightFacts {
  now: Date;
  /** Present only for sites where the `suggest.monitor_infrastructure` automation is enabled. */
  infrastructure?: InfrastructureFact[];
  /** How many match in total (`infrastructure` holds at most INFRASTRUCTURE_LIMIT of them). Defaults to its length. */
  infrastructureTotal?: number;
  devices: DeviceFact[];
  /** Collectors that are enrolled (active). */
  collectors: { id: string; name: string; last_heartbeat_at: Date | null; gateway_ip: string | null }[];
  scopes: number;
  checks: {
    id: string;
    name: string;
    role: 'gateway' | 'internet' | 'dns' | 'service';
    state: 'unknown' | 'ok' | 'degraded' | 'down';
    last_latency_ms: number | null;
    last_loss_pct: number | null;
    /** Watch checks (optional for older callers): kind, last error, measured value, certificate expiry seen. */
    kind?: string;
    last_error?: string | null;
    last_value?: number | null;
    cert_not_after?: string | null;
  }[];
  openIncidents: { id: string; title: string; severity: Severity }[];
  /** ip_mac_changed events in the last 24 hours. */
  ipConflicts: { ip: string; at: Date }[];
  /** Port Detective: switches that stopped answering and ports whose error counters are rising. */
  ports?: {
    unreadable: { id: string; name: string; error: string | null }[];
    erroring: { target_id: string; switch_name: string; port_name: string; errors: number; seconds: number }[];
  };
  /**
   * Router control: for each unwanted device that is online, the configured routers that can block it
   * (block supported, reachable, logins not paused, no block of Nigafiy's own already open).
   */
  routerBlockable?: { device_id: string; router_id: string; router_name: string }[];
  /** Network access control (DNS filter), when the site has it configured. */
  access?: {
    enabled: boolean;
    listening: boolean | null;
    error: string | null;
    dns_server_ip: string | null;
    protected_devices: number;
    online_devices: number;
    /** Blocked attempts in the last 24 hours, per device and category. */
    blocked: { device_id: string; label: string; category: string; count: number }[];
  };
}

const COLLECTOR_SILENT_MS = 3 * 60_000;
const DAY_MS = 24 * 3600_000;
/** Certificates seen by watch checks are reported this many days before they expire. */
export const CERT_WARN_DAYS = 30;
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

const link = (code: string, label: string, href: string): InsightAction => ({ code, label, kind: 'link', href });
const external = (code: string, label: string, href: string): InsightAction => ({ code, label, kind: 'external', href });
const api = (code: string, label: string, href: string, body?: Record<string, unknown>, confirm?: string): InsightAction => ({ code, label, kind: 'api', href, body, confirm });
const list = (labels: string[], max = 4) => (labels.length > max ? `${labels.slice(0, max).join(', ')} +${labels.length - max}` : labels.join(', '));
const ago = (now: Date, at: Date) => {
  const min = Math.round((now.getTime() - at.getTime()) / 60_000);
  return min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
};

export function buildInsights(f: InsightFacts): InsightsReport {
  const out: Insight[] = [];
  const deductions: InsightsReport['score_breakdown'] = [];
  const deduct = (code: string, reason: string, points: number) => points > 0 && deductions.push({ code, reason, points });
  const add = (i: Omit<Insight, 'params'> & { params?: Insight['params'] }) => out.push({ params: {}, ...i });
  const gateway = f.collectors.find((c) => c.gateway_ip)?.gateway_ip ?? null;
  const routerAction = gateway ? [external('open_router', 'Open router settings', `http://${gateway}/`)] : [];

  // ── setup ──
  if (f.collectors.length === 0 || f.scopes === 0) {
    add({
      id: 'setup',
      code: f.collectors.length === 0 ? 'no_collector' : 'no_scope',
      severity: 'warning',
      category: 'setup',
      title: f.collectors.length === 0 ? 'Nothing is watching your network yet' : 'No network range is authorized for scanning',
      detail: 'Add a collector and authorize your network range to start discovering devices.',
      evidence: [`${f.collectors.length} collector(s), ${f.scopes} authorized range(s)`],
      actions: [link('open_collectors', 'Set up discovery', '/radar/discovery')],
    });
    deduct('setup', 'Discovery is not set up', 40);
  }
  for (const c of f.collectors) {
    const silentFor = c.last_heartbeat_at ? f.now.getTime() - c.last_heartbeat_at.getTime() : Infinity;
    if (silentFor > COLLECTOR_SILENT_MS) {
      add({
        id: `collector-silent-${c.id}`,
        code: 'collector_silent',
        params: { name: c.name, since: c.last_heartbeat_at ? ago(f.now, c.last_heartbeat_at) : '—' },
        severity: 'critical',
        category: 'setup',
        title: `Monitoring is paused: collector "${c.name}" is not reporting`,
        detail: 'Device states shown are the last known ones. Check that the computer running the collector is on and connected.',
        evidence: [c.last_heartbeat_at ? `Last heartbeat ${ago(f.now, c.last_heartbeat_at)} ago` : 'Never reported'],
        actions: [link('open_collectors', 'Open collectors', '/radar/discovery')],
      });
      deduct('collector_silent', `Collector ${c.name} is not reporting`, 30);
    }
  }

  // ── security ──
  const unwantedOnline = f.devices.filter((d) => d.trust === 'unwanted' && d.status === 'online');
  for (const d of unwantedOnline) {
    add({
      id: `unwanted-${d.id}`,
      code: 'unwanted_online',
      params: { device: d.label, ip: d.ip ?? '—' },
      severity: 'critical',
      category: 'security',
      title: `Unwanted device is on your network: ${d.label}`,
      detail: 'You marked this device as unwanted. To remove it, block its MAC address in your router and change the Wi-Fi password if you do not know who it is.',
      evidence: [`Answered the last sweep at ${d.ip ?? 'unknown address'}`, `Marked unwanted by you`],
      actions: [link('open_device', 'Open device', `/radar/devices/${d.id}`), ...routerAction],
    });
  }
  // A router that can block an unwanted device: proposed with one action. Never blocked automatically.
  for (const d of unwantedOnline) {
    const r = (f.routerBlockable ?? []).find((b) => b.device_id === d.id);
    if (!r) continue;
    add({
      id: `unwanted-block-${d.id}`,
      code: 'unwanted_blockable',
      params: { device: d.label, router: r.router_name },
      severity: 'warning',
      category: 'security',
      title: `Block ${d.label} on ${r.router_name}?`,
      detail: 'You marked this device as unwanted and it is online. Your router can block it. Nigafiy does not do this on its own: it waits for you.',
      evidence: [`Marked unwanted by you`, `Online at ${d.ip ?? 'unknown address'}`, `${r.router_name} supports blocking devices`],
      actions: [api('block_on_router', `Block on ${r.router_name}`, `/api/v1/routers/${r.router_id}/block`, { device_ids: [d.id] }, `Block ${d.label} on ${r.router_name}?`)],
    });
  }
  deduct('unwanted_online', `${unwantedOnline.length} unwanted device(s) online`, Math.min(50, unwantedOnline.length * 25));

  const unreviewed = f.devices.filter((d) => d.trust === 'unreviewed');
  if (unreviewed.length) {
    const recent = unreviewed.filter((d) => f.now.getTime() - d.first_seen_at.getTime() < DAY_MS);
    add({
      id: 'unreviewed',
      code: 'unreviewed',
      params: { count: unreviewed.length, recent: recent.length, names: list(unreviewed.map((d) => d.label)) },
      severity: recent.length ? 'warning' : 'info',
      category: 'security',
      title: `${unreviewed.length} device(s) waiting for your review`,
      detail: 'Mark the ones you recognize as Known. You will then be alerted only about devices you have not seen before.',
      evidence: [list(unreviewed.map((d) => d.label)), recent.length ? `${recent.length} joined in the last 24 hours` : 'None joined in the last 24 hours'],
      actions: [
        link('review', 'Review devices', '/radar/devices?trust=unreviewed'),
        api('mark_all_known', 'Mark all as known', '/api/v1/devices/trust', { all_unreviewed: true, trust: 'known' }, `Mark all ${unreviewed.length} unreviewed devices as known?`),
      ],
    });
    deduct('unreviewed', `${unreviewed.length} unreviewed device(s)`, Math.min(20, unreviewed.length * 2));
  }

  if (f.ipConflicts.length) {
    const ips = [...new Set(f.ipConflicts.map((c) => c.ip))];
    add({
      id: 'ip-conflicts',
      code: 'ip_conflict',
      params: { count: ips.length, ips: list(ips) },
      severity: 'warning',
      category: 'security',
      title: `${ips.length} address(es) changed hands in the last 24 hours`,
      detail: 'Usually harmless (an address reused by the router, or a phone with a private MAC). It can also mean an IP conflict, or a device pretending to be another one. Compare the devices involved.',
      evidence: ips.map((ip) => `${ip} was answered by a different MAC address`),
      actions: [link('open_events', 'See the events', '/watch/events?type=ip_mac_changed')],
    });
    deduct('ip_conflict', 'Addresses changed hands', 10);
  }

  // ── availability ──
  const role = (r: InsightFacts['checks'][number]['role']) => f.checks.filter((c) => c.role === r);
  const worst = (cs: InsightFacts['checks']) => (cs.some((c) => c.state === 'down') ? 'down' : cs.some((c) => c.state === 'degraded') ? 'degraded' : null);
  const gw = worst(role('gateway'));
  const inet = worst(role('internet'));
  const dns = worst(role('dns'));
  if (gw || inet || dns) {
    const what = gw ? 'gateway' : inet ? 'internet' : 'dns';
    const state = (gw ?? inet ?? dns)!;
    add({
      id: 'path',
      code: `path_${what}_${state}`,
      severity: state === 'down' ? 'critical' : 'warning',
      category: 'availability',
      title: what === 'gateway' ? `Your router is ${state === 'down' ? 'not responding' : 'responding poorly'}` : what === 'internet' ? `The internet connection is ${state === 'down' ? 'down' : 'degraded'}` : `Name resolution (DNS) is ${state === 'down' ? 'failing' : 'slow or unreliable'}`,
      detail: 'Network Doctor compares all measurements to tell where the problem is (your network, the router, or the provider).',
      evidence: f.checks.filter((c) => c.state === 'down' || c.state === 'degraded').map((c) => `${c.name}: ${c.state}${c.last_latency_ms != null ? `, ${Math.round(c.last_latency_ms)} ms` : ''}${c.last_loss_pct ? `, ${Math.round(c.last_loss_pct)}% loss` : ''}`),
      actions: [link('open_doctor', 'Diagnose with Network Doctor', '/watch/doctor')],
    });
    deduct(`path_${what}`, `${what} ${state}`, state === 'down' ? (what === 'gateway' ? 30 : what === 'internet' ? 25 : 15) : 10);
  } else {
    const slow = role('internet').filter((c) => c.state === 'ok' && (c.last_latency_ms ?? 0) > 150);
    if (slow.length) {
      add({
        id: 'slow-internet',
        code: 'slow_internet',
        params: { ms: Math.round(slow[0]!.last_latency_ms!) },
        severity: 'info',
        category: 'performance',
        title: `Internet response time is high (${Math.round(slow[0]!.last_latency_ms!)} ms)`,
        detail: 'Video calls and games feel this. It is often caused by heavy downloads on the network or by the provider.',
        evidence: slow.map((c) => `${c.name}: ${Math.round(c.last_latency_ms!)} ms`),
        actions: [link('open_monitoring', 'See the history', '/watch/monitoring')],
      });
      deduct('slow_internet', 'High internet latency', 5);
    }
  }

  // ── certificates seen by watch checks (tls_expiry, https) ──
  const certDays = (c: InsightFacts['checks'][number]): number | null => {
    if (c.kind === 'tls_expiry' && !c.last_error && c.last_value != null) return c.last_value;
    if (c.kind === 'https' && c.cert_not_after) return (new Date(c.cert_not_after).getTime() - f.now.getTime()) / DAY_MS;
    return null;
  };
  const expiring = f.checks
    .map((c) => ({ c, days: certDays(c) }))
    .filter((x): x is { c: InsightFacts['checks'][number]; days: number } => x.days !== null && x.days <= CERT_WARN_DAYS)
    .sort((a, b) => a.days - b.days);
  if (expiring.length) {
    const soonest = expiring[0]!.days;
    add({
      id: 'certificates-expiring',
      code: 'certificate_expiring',
      params: { count: expiring.length, checks: list(expiring.map((x) => x.c.name)), days: Math.floor(soonest) },
      severity: soonest <= 7 ? 'critical' : 'warning',
      category: 'availability',
      title: soonest < 0 ? `${expiring.length} certificate(s) expired or expiring soon` : `${expiring.length} certificate(s) expire within ${CERT_WARN_DAYS} days`,
      detail: 'Clients that verify certificates will refuse these services once the certificate expires. Renew and install the new certificate before then.',
      evidence: expiring.map((x) => (x.days < 0 ? `${x.c.name}: expired ${Math.ceil(-x.days)} day(s) ago` : `${x.c.name}: expires in ${Math.floor(x.days)} day(s)`)),
      actions: [link('open_monitoring', 'See the checks', '/watch/monitoring')],
    });
    deduct('certificate_expiring', 'Certificates expiring', soonest <= 7 ? 15 : 5);
  }
  const refused = f.checks.filter((c) => (c.last_error ?? '').startsWith('refused:'));
  if (refused.length) {
    add({
      id: 'watch-refused',
      code: 'watch_refused',
      params: { count: refused.length, checks: list(refused.map((c) => c.name)) },
      severity: 'warning',
      category: 'setup',
      title: `${refused.length} check(s) cannot run: the target is not allowed`,
      detail: 'The collector refuses to connect to addresses outside the authorized ranges of the site, and to public hosts unless the check allows them. Nothing is sent to these targets.',
      evidence: refused.map((c) => `${c.name}: ${c.last_error}`),
      actions: [link('open_monitoring', 'Open the checks', '/watch/monitoring')],
    });
    deduct('watch_refused', 'Checks refused by the scope rule', 5);
  }

  const criticalDown = f.devices.filter((d) => d.is_critical && d.status === 'offline');
  for (const d of criticalDown) {
    add({
      id: `critical-down-${d.id}`,
      code: 'critical_offline',
      params: { device: d.label, since: ago(f.now, d.last_seen_at) },
      severity: 'critical',
      category: 'availability',
      title: `${d.label} is offline`,
      detail: 'You marked this device as important. It stopped answering on the network.',
      evidence: [`Last seen ${ago(f.now, d.last_seen_at)} ago${d.ip ? ` at ${d.ip}` : ''}`],
      actions: [link('open_device', 'Open device', `/radar/devices/${d.id}`)],
    });
  }
  deduct('critical_offline', `${criticalDown.length} important device(s) offline`, Math.min(30, criticalDown.length * 10));

  if (f.openIncidents.length) {
    const top = [...f.openIncidents].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0]!;
    add({
      id: 'incidents',
      code: 'open_incidents',
      params: { count: f.openIncidents.length, top: top.title },
      severity: top.severity,
      category: 'availability',
      title: `${f.openIncidents.length} open incident(s)`,
      detail: `Most important: ${top.title}`,
      evidence: f.openIncidents.slice(0, 5).map((i) => i.title),
      actions: [link('open_incidents', 'Open incidents', '/watch/incidents')],
    });
    deduct('open_incidents', 'Open incidents', top.severity === 'critical' ? 15 : top.severity === 'warning' ? 5 : 0);
  }

  // ── suggestions ──
  const unmonitored = f.devices.filter((d) => d.is_critical && !d.monitored && d.ip);
  for (const d of unmonitored.slice(0, 3)) {
    add({
      id: `monitor-${d.id}`,
      code: 'suggest_monitor',
      params: { device: d.label },
      severity: 'info',
      category: 'availability',
      title: `Watch ${d.label} more closely`,
      detail: 'It is marked important but is only checked during discovery sweeps. A ping check measures it every minute and records latency.',
      evidence: ['Marked important', 'No monitoring check'],
      actions: [api('monitor', 'Monitor it', `/api/v1/devices/${d.id}/monitor`)],
    });
  }

  // Infrastructure that was classified automatically: proposed, never monitored without the user's click.
  const suggestedAlready = new Set(unmonitored.slice(0, 3).map((d) => d.id));
  const infraAll = f.infrastructure ?? [];
  const infra = infraAll.filter((d) => !suggestedAlready.has(d.id));
  // Exact count when the read was capped: the total minus the ones already suggested above.
  const infraCount = Math.max(infra.length, (f.infrastructureTotal ?? infraAll.length) - (infraAll.length - infra.length));
  if (infra.length) {
    const TYPE_LABEL: Record<InfrastructureFact['device_type'], string> = {
      router: 'router',
      printer: 'printer',
      nas: 'NAS',
      camera: 'camera',
      access_point: 'access point',
      server: 'server',
    };
    add({
      id: 'monitor-infrastructure',
      code: 'suggest_monitor_infrastructure',
      params: { count: infraCount, names: list(infra.map((d) => d.label)) },
      severity: 'info',
      category: 'availability',
      title: `Watch ${infraCount} infrastructure device(s) continuously`,
      detail:
        'These look like routers, printers, storage, cameras, access points or servers. They are only checked during discovery sweeps; a ping check measures each one every minute. Their type was worked out automatically: check it before you accept.',
      evidence: infra.slice(0, 8).map((d) => `${d.label} (${d.ip}): looks like a ${TYPE_LABEL[d.device_type]} — inferred, ${d.type_confidence} confidence${d.type_evidence ? `: ${d.type_evidence}` : ''}`),
      actions: [
        api('monitor_all', 'Monitor them', '/api/v1/devices/monitor', { ids: infra.slice(0, 200).map((d) => d.id) }, `Create a ping check for ${Math.min(infra.length, 200)} device(s)?`),
        link('review', 'Review devices', '/radar/devices'),
      ],
      devices: infra.map((d) => ({
        device_id: d.id,
        label: d.label,
        ip: d.ip,
        device_type: d.device_type,
        type_confidence: d.type_confidence,
        inferred: true as const,
        evidence: d.type_evidence,
      })),
    });
  }

  const nameless = f.devices.filter((d) => d.mac_randomized && !d.named && d.status === 'online');
  if (nameless.length >= 2) {
    add({
      id: 'nameless-phones',
      code: 'nameless_phones',
      params: { count: nameless.length },
      severity: 'info',
      category: 'inventory',
      title: `${nameless.length} phones or tablets have no name yet`,
      detail: 'They use private Wi-Fi addresses and stay silent. Turn Wi-Fi off and on again on a phone: Nigafiy learns its name when it reconnects.',
      evidence: [`${nameless.length} online devices with a private (randomized) MAC and no announced name`],
      actions: [link('review', 'See them', '/radar/devices?type=mobile')],
    });
  }

  const newToday = f.devices.filter((d) => f.now.getTime() - d.first_seen_at.getTime() < DAY_MS && d.trust !== 'unreviewed');
  if (newToday.length) {
    add({
      id: 'new-today',
      code: 'new_today',
      params: { count: newToday.length, names: list(newToday.map((d) => d.label)) },
      severity: 'info',
      category: 'inventory',
      title: `${newToday.length} device(s) joined today`,
      detail: list(newToday.map((d) => d.label)),
      evidence: newToday.slice(0, 5).map((d) => `${d.label}${d.ip ? ` (${d.ip})` : ''}`),
      actions: [link('review', 'See devices', '/radar/devices?sort=first_seen')],
    });
  }

  for (const sw of f.ports?.unreadable ?? []) {
    add({
      id: `switch-unreadable-${sw.id}`,
      code: 'switch_unreadable',
      params: { name: sw.name },
      severity: 'warning',
      category: 'setup',
      title: `Switch ${sw.name} is not answering SNMP`,
      detail: 'Port information for it is as of the last successful read. Check that SNMP is enabled on it and the credentials are current.',
      evidence: [sw.error ?? 'The last read failed'],
      actions: [link('open_ports', 'Open Port Detective', '/radar/ports')],
    });
    deduct('switch_unreadable', `Switch ${sw.name} unreadable`, 5);
  }
  const bad = (f.ports?.erroring ?? []).slice().sort((a, b) => b.errors / b.seconds - a.errors / a.seconds);
  if (bad.length) {
    add({
      id: 'port-errors',
      code: 'port_errors',
      params: { count: bad.length, ports: list(bad.map((b) => `${b.switch_name} ${b.port_name}`)) },
      severity: 'warning',
      category: 'performance',
      title: `${bad.length} switch port(s) are logging errors`,
      detail: 'Rising error counters usually mean a bad cable, a failing port or a duplex mismatch. Whatever is plugged in there will be slow or drop out.',
      evidence: bad.slice(0, 5).map((b) => `${b.switch_name} ${b.port_name}: ${b.errors} new error(s) in ${Math.round(b.seconds / 60)} min`),
      actions: [link('open_ports', 'See the ports', `/radar/ports?switch=${bad[0]!.target_id}`)],
    });
    deduct('port_errors', 'Switch ports with errors', Math.min(15, bad.length * 5));
  }

  const ac = f.access;
  if (ac?.enabled) {
    if (ac.listening === false || ac.error) {
      add({
        id: 'access-not-running',
        code: 'access_not_running',
        params: { error: ac.error ?? '' },
        severity: 'warning',
        category: 'setup',
        title: 'Access control is on but not running',
        detail: 'The collector could not start its DNS filter, so no rules are applied.',
        evidence: [ac.error ?? 'The collector reports it is not listening for DNS'],
        actions: [link('open_access', 'Open access control', '/guard/access')],
      });
      deduct('access_not_running', 'Access control not running', 15);
    } else if (ac.protected_devices === 0) {
      add({
        id: 'access-no-devices',
        code: 'access_no_devices',
        params: { ip: ac.dns_server_ip ?? '' },
        severity: 'warning',
        category: 'setup',
        title: 'No device is using Nigafiy for DNS yet',
        detail: `Set the router's DHCP "DNS server" to ${ac.dns_server_ip ?? 'this computer'} so devices receive the rules, then reconnect them to Wi-Fi.`,
        evidence: ['No DNS questions arrived from any device in the last 30 minutes'],
        actions: [link('open_access', 'Show me how', '/guard/access')],
      });
      deduct('access_no_devices', 'Access rules reach no device', 10);
    } else if (ac.protected_devices < ac.online_devices) {
      add({
        id: 'access-partial',
        code: 'access_partial',
        params: { protected: ac.protected_devices, online: ac.online_devices },
        severity: 'info',
        category: 'setup',
        title: `${ac.protected_devices} of ${ac.online_devices} online devices use the filter`,
        detail: 'The others did not ask Nigafiy for any name recently: they may use their own DNS (Private DNS, VPN) or not have renewed their address yet.',
        evidence: [`${ac.protected_devices} devices sent DNS questions in the last 30 minutes`],
        actions: [link('open_access', 'See which', '/guard/access')],
      });
    }
    const byCat = (cat: string) => ac.blocked.filter((b) => b.category === cat).sort((a, b) => b.count - a.count);
    const adult = byCat('adult');
    if (adult.length) {
      add({
        id: 'adult-attempts',
        code: 'adult_attempts',
        params: { names: list(adult.map((b) => b.label)), count: adult.reduce((n, b) => n + b.count, 0) },
        severity: 'warning',
        category: 'security',
        title: 'Adult content was blocked in the last 24 hours',
        detail: list(adult.map((b) => `${b.label} (${b.count})`)),
        evidence: adult.slice(0, 5).map((b) => `${b.label}: ${b.count} blocked request(s)`),
        actions: [link('see_activity', 'See activity', `/radar/devices/${adult[0]!.device_id}`)],
      });
    }
    const bypass = byCat('encrypted_dns');
    if (bypass.length) {
      add({
        id: 'bypass-attempts',
        code: 'bypass_attempts',
        params: { names: list(bypass.map((b) => b.label)) },
        severity: 'info',
        category: 'security',
        title: 'Some devices tried to use their own encrypted DNS',
        detail: 'It was blocked so they fall back to the network rules. If a device keeps bypassing, turn off "Private DNS" on it.',
        evidence: bypass.slice(0, 5).map((b) => `${b.label}: ${b.count} attempt(s)`),
        actions: [link('open_access', 'Open access control', '/guard/access')],
      });
    }
  } else if (ac && !ac.enabled && f.devices.length > 0 && f.collectors.length > 0) {
    add({
      id: 'access-off',
      code: 'access_off',
      params: {},
      severity: 'info',
      category: 'setup',
      title: 'Control what devices can reach',
      detail: 'Block sites and apps, pause the internet for a device, or set bedtimes. Works with any router.',
      evidence: ['Access control is off for this network'],
      actions: [link('open_access', 'Set up access control', '/guard/access')],
    });
  }

  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const score = Math.max(0, 100 - deductions.reduce((s, d) => s + d.points, 0));
  const critical = out.filter((i) => i.severity === 'critical').length;
  const verdict = verdictFor(score, critical);
  const online = f.devices.filter((d) => d.status === 'online').length;
  const summary =
    verdict === 'healthy'
      ? `Your network looks healthy: ${online} device(s) online and nothing needs you right now.`
      : verdict === 'attention'
        ? `A few things need your attention (${out.filter((i) => i.severity !== 'info').length}).`
        : `Your network needs attention now: ${critical} critical finding(s).`;
  return { generated_at: f.now.toISOString(), score, score_breakdown: deductions, verdict, summary, insights: out };
}

/**
 * "Act now" only when a finding is critical (something is down, an unwanted device is online, a
 * certificate is about to expire...). Housekeeping alone (devices not reviewed yet, rules that reach no
 * device yet) lowers the score but never turns the verdict red: a red "act now" with nothing broken
 * teaches people to ignore it.
 */
export function verdictFor(score: number, critical: number): InsightsReport['verdict'] {
  if (critical > 0) return 'urgent';
  return score >= 90 ? 'healthy' : 'attention';
}
