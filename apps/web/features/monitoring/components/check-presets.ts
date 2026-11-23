import type { CheckKind, CheckRole } from '@nigafiy/shared-types';

export const AUTO_GATEWAY = 'auto:gateway';

export interface Thresholds {
  interval_seconds: number;
  failure_threshold: number;
  latency_warn_ms: number | null;
  loss_warn_pct: number | null;
}

/**
 * The values the API itself uses, so a check added by hand starts like the ones LAN Detective creates:
 * gateway / internet / DNS mirror the starter checks (apps/api monitoring/defaults.ts), a service the
 * one-click device monitor (apps/api devices/monitor.ts: 60 s, 3 samples, 200 ms, 20 %).
 */
const PRESETS: Record<CheckRole, Thresholds> = {
  gateway: { interval_seconds: 30, failure_threshold: 3, latency_warn_ms: 50, loss_warn_pct: 5 },
  internet: { interval_seconds: 30, failure_threshold: 3, latency_warn_ms: 150, loss_warn_pct: 5 },
  dns: { interval_seconds: 60, failure_threshold: 3, latency_warn_ms: 300, loss_warn_pct: null },
  service: { interval_seconds: 60, failure_threshold: 3, latency_warn_ms: 200, loss_warn_pct: 20 },
};

/** Loss is only measured by ping checks. */
export function presetFor(role: CheckRole, kind: CheckKind): Thresholds {
  const p = PRESETS[role];
  return kind === 'icmp' ? p : { ...p, loss_warn_pct: null };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Private, loopback, link-local, CGNAT or otherwise not on the public internet. */
function isLocalIPv4(target: string): boolean {
  const m = IPV4.exec(target);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** The role a check most likely plays, from what it targets. Shown as inferred and editable in the form. */
export function inferRole(kind: CheckKind, target: string): CheckRole {
  const t = target.trim();
  if (t === AUTO_GATEWAY) return 'gateway';
  if (kind === 'dns') return 'dns';
  // Web pages, certificates and device metrics are services; the admin can still pick a path role.
  if (kind !== 'icmp' && kind !== 'tcp') return 'service';
  if (IPV4.test(t) && !isLocalIPv4(t)) return 'internet';
  return 'service';
}
