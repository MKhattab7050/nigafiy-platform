import type { CheckState, DeviceStatus, EndpointState, Severity } from '@nigafiy/shared-types';

/** State colours: the only place state → colour is decided. Every tone also has an icon (status.tsx). */
export const TONE = {
  ok: { dot: 'bg-ok', text: 'text-ok', soft: 'bg-ok/10 text-ok border-ok/30', fill: 'bg-ok', stroke: 'var(--color-ok)' },
  warn: { dot: 'bg-warn', text: 'text-warn', soft: 'bg-warn/10 text-warn border-warn/30', fill: 'bg-warn', stroke: 'var(--color-warn)' },
  crit: { dot: 'bg-crit', text: 'text-crit', soft: 'bg-crit/10 text-crit border-crit/30', fill: 'bg-crit', stroke: 'var(--color-crit)' },
  idle: { dot: 'bg-idle', text: 'text-muted', soft: 'bg-idle/10 text-muted border-idle/30', fill: 'bg-idle', stroke: 'var(--color-idle)' },
  info: { dot: 'bg-accent', text: 'text-accent-hover', soft: 'bg-accent/10 text-accent-hover border-accent/30', fill: 'bg-accent', stroke: 'var(--color-accent)' },
} as const;
export type Tone = keyof typeof TONE;

/**
 * Device and endpoint states: one tone per state on every screen (badge, dot, count, chart slice).
 * online: connected. offline: known, not connected now. unknown: state not known (no Sensor watching;
 * never counted as offline). pending: waiting for enrollment or a first check-in (warn: someone has to finish it). revoked: access taken away.
 * "Monitoring off" in history is not a state of the device and keeps its own look (availability strip).
 */
export type ConnState = DeviceStatus | EndpointState;
const CONN_TONE: Record<ConnState, Tone> = { online: 'ok', offline: 'crit', unknown: 'idle', pending: 'warn', revoked: 'idle' };
export const statusTone = (s: ConnState): Tone => CONN_TONE[s] ?? 'idle';
/** CSS colour for a state in charts (proportion bars, donuts), so slices match the badges. */
export const statusColor = (s: ConnState): string => TONE[statusTone(s)].stroke;
export const stateTone = (s: CheckState | null): Tone => (s === 'ok' ? 'ok' : s === 'degraded' ? 'warn' : s === 'down' ? 'crit' : 'idle');
export const severityTone = (s: Severity): Tone => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'info');
