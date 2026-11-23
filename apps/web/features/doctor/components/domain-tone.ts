import type { FaultDomain } from '@nigafiy/shared-types';
import type { Tone } from '@/components/ui';

export const domainTone = (d: FaultDomain): Tone => (d === 'healthy' ? 'ok' : d === 'insufficient_data' ? 'idle' : d === 'wan_quality' || d === 'lan_quality' || d === 'remote_target' ? 'warn' : 'crit');
