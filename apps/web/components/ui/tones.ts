import type { CheckState, DeviceStatus, Severity } from '@nigafiy/shared-types';

/** State colours: the only place state → colour is decided. Every tone also has an icon (status.tsx). */
export const TONE = {
  ok: { dot: 'bg-ok', text: 'text-ok', soft: 'bg-ok/10 text-ok border-ok/30', fill: 'bg-ok', stroke: 'var(--color-ok)' },
  warn: { dot: 'bg-warn', text: 'text-warn', soft: 'bg-warn/10 text-warn border-warn/30', fill: 'bg-warn', stroke: 'var(--color-warn)' },
  crit: { dot: 'bg-crit', text: 'text-crit', soft: 'bg-crit/10 text-crit border-crit/30', fill: 'bg-crit', stroke: 'var(--color-crit)' },
  idle: { dot: 'bg-idle', text: 'text-muted', soft: 'bg-idle/10 text-muted border-idle/30', fill: 'bg-idle', stroke: 'var(--color-idle)' },
  info: { dot: 'bg-accent', text: 'text-accent-hover', soft: 'bg-accent/10 text-accent-hover border-accent/30', fill: 'bg-accent', stroke: 'var(--color-accent)' },
} as const;
export type Tone = keyof typeof TONE;

export const statusTone = (s: DeviceStatus): Tone => (s === 'online' ? 'ok' : s === 'offline' ? 'crit' : 'idle');
export const stateTone = (s: CheckState | null): Tone => (s === 'ok' ? 'ok' : s === 'degraded' ? 'warn' : s === 'down' ? 'crit' : 'idle');
export const severityTone = (s: Severity): Tone => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'info');
