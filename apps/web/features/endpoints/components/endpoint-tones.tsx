'use client';

import { Meter as KitMeter } from '@/components/charts';
import type { EndpointComplianceStatus } from '@nigafiy/shared-types';
import type { Tone } from '@/components/ui';

export function complianceTone(status: EndpointComplianceStatus): Tone {
  if (status === 'compliant') return 'ok';
  if (status === 'non_compliant') return 'crit';
  if (status === 'attention') return 'warn';
  return 'idle';
}

/** Compact load meter for endpoint cards (the shared chart-kit meter, 75 % / 90 % thresholds). */
export function Meter({ value, label }: { value: number | null; label: string }) {
  return <KitMeter size="sm" label={label} value={value} warn={75} crit={90} />;
}
