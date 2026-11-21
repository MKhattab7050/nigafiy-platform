'use client';

import type { IpamAddress } from '@lan-detective/shared-types';
import type { Tone } from '@/components/ui';

export const STATE_TONE: Record<IpamAddress['state'], Tone> = { online: 'ok', offline: 'idle', unknown: 'idle', documented: 'info', infrastructure: 'idle' };

/** Stacked bar: online, seen-but-offline, documented-only; the remainder is free. Always paired with the numbers as text. */
export function UsageBar({ usable, online, offline, documented }: { usable: number; online: number; offline: number; documented: number }) {
  const w = (n: number) => `${usable > 0 ? Math.min(100, (n / usable) * 100) : 0}%`;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden>
      <span className="bg-ok" style={{ width: w(online) }} />
      <span className="bg-idle" style={{ width: w(offline) }} />
      <span className="bg-accent" style={{ width: w(documented) }} />
    </div>
  );
}
