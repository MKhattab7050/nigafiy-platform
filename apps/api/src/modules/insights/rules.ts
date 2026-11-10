import type { Insight, InsightAction, InsightsReport, Severity } from '@lan-detective/shared-types';

/**
 * Smart insights: deterministic rules over facts already stored by LAN Detective.
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

export interface InsightFacts {
  now: Date;
  devices: DeviceFact[];
  /** Collectors that are enrolled (active). */
  collectors: { id: string; name: string; last_heartbeat_at: Date | null; gateway_ip: string | null }[];
  scopes: number;
  checks: { id: string; name: string; role: 'gateway' | 'internet' | 'dns' | 'service'; state: 'unknown' | 'ok' | 'degraded' | 'down'; last_latency_ms: number | null; last_loss_pct: number | null }[];
  openIncidents: { id: string; title: string; severity: Severity }[];
  /** ip_mac_changed events in the last 24 hours. */
  ipConflicts: { ip: string; at: Date }[];
}

const COLLECTOR_SILENT_MS = 3 * 60_000;
const DAY_MS = 24 * 3600_000;
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
      actions: [link('open_collectors', 'Set up discovery', '/discovery')],
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
        actions: [link('open_collectors', 'Open collectors', '/discovery')],
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
      actions: [link('open_device', 'Open device', `/devices/${d.id}`), ...routerAction],
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
        link('review', 'Review devices', '/devices?trust=unreviewed'),
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
      actions: [link('open_events', 'See the events', '/events?type=ip_mac_changed')],
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
      actions: [link('open_doctor', 'Diagnose with Network Doctor', '/doctor')],
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
        actions: [link('open_monitoring', 'See the history', '/monitoring')],
      });
      deduct('slow_internet', 'High internet latency', 5);
    }
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
      actions: [link('open_device', 'Open device', `/devices/${d.id}`)],
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
      actions: [link('open_incidents', 'Open incidents', '/incidents')],
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

  const nameless = f.devices.filter((d) => d.mac_randomized && !d.named && d.status === 'online');
  if (nameless.length >= 2) {
    add({
      id: 'nameless-phones',
      code: 'nameless_phones',
      params: { count: nameless.length },
      severity: 'info',
      category: 'inventory',
      title: `${nameless.length} phones or tablets have no name yet`,
      detail: 'They use private Wi-Fi addresses and stay silent. Turn Wi-Fi off and on again on a phone: LAN Detective learns its name when it reconnects.',
      evidence: [`${nameless.length} online devices with a private (randomized) MAC and no announced name`],
      actions: [link('review', 'See them', '/devices?type=mobile')],
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
      actions: [link('review', 'See devices', '/devices?sort=first_seen')],
    });
  }

  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const score = Math.max(0, 100 - deductions.reduce((s, d) => s + d.points, 0));
  const verdict = score >= 90 ? 'healthy' : score >= 70 ? 'attention' : 'urgent';
  const online = f.devices.filter((d) => d.status === 'online').length;
  const summary =
    verdict === 'healthy'
      ? `Your network looks healthy: ${online} device(s) online and nothing needs you right now.`
      : verdict === 'attention'
        ? `A few things need your attention (${out.filter((i) => i.severity !== 'info').length}).`
        : `Your network needs attention now: ${out.filter((i) => i.severity === 'critical').length} critical finding(s).`;
  return { generated_at: f.now.toISOString(), score, score_breakdown: deductions, verdict, summary, insights: out };
}
