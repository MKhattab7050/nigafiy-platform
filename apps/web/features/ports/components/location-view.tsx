'use client';

import type { PortLocation } from '@lan-detective/shared-types';
import { Cable } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { portsText, locationLine } from '../text';

export const TONE = { high: 'ok', medium: 'warn', low: 'idle' } as const;

/** One located device: the sentence, how sure, and the observations behind it. */
export function LocationView({ loc }: { loc: PortLocation }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Cable className="size-4 shrink-0 text-accent" aria-hidden />
        <Link href={`/ports?switch=${loc.target_id}`} className="font-medium hover:text-accent-hover" dir="auto">
          {locationLine(loc, locale)}
        </Link>
        <Badge tone={TONE[loc.confidence]} dot={false}>
          {tx.confidence[loc.confidence]}
        </Badge>
        {loc.vlan > 0 && <Badge tone="idle" dot={false}>VLAN {loc.vlan}</Badge>}
      </p>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">{tx.why}</summary>
        <ul className="mt-1 list-disc space-y-0.5 ps-5">
          {loc.evidence.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
