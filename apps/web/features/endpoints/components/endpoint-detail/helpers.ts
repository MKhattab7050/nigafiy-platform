import type { CapabilityState, EndpointCommand, EndpointCommandStatus } from '@nigafiy/shared-types';
import type { Tone } from '@/components/ui';

export type Tab =
  | 'overview'
  | 'desktop'
  | 'files'
  | 'processes'
  | 'services'
  | 'connections'
  | 'software'
  | 'diagnostics'
  | 'security'
  | 'commands';

export function cmdTone(status: EndpointCommandStatus): Tone {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'expired') return 'crit';
  return 'info';
}

export function capStateTone(state: CapabilityState): Tone {
  if (state === 'tested' || state === 'supported' || state === 'implemented') return 'ok';
  if (
    state === 'partially_supported' ||
    state === 'requires_permissions' ||
    state === 'requires_external_config'
  ) {
    return 'warn';
  }
  if (state === 'unsupported_by_os') return 'crit';
  return 'idle';
}

export function formatUptime(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export type SendCommand = (key: string, body: Record<string, unknown>, successNotice?: string, waitMs?: number) => Promise<EndpointCommand | null>;
export type SeriesRange = '15m' | '1h' | '24h' | '7d';
export type LogSource = 'system' | 'application' | 'security';
