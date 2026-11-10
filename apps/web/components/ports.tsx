'use client';

import type { DevicePort, PortLocation } from '@lan-detective/shared-types';
import { Cable } from 'lucide-react';
import Link from 'next/link';
import { Badge, Spinner } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { locationLine, portsText } from '@/lib/ports-text';

const TONE = { high: 'ok', medium: 'warn', low: 'idle' } as const;

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

/** Device page card. */
export function DevicePortCard({ deviceId }: { deviceId: string }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const q = useQuery<DevicePort>(`/devices/${deviceId}/port`, ['devices'], 60_000);
  if (!q.data) return <Spinner />;
  const d = q.data;
  if (d.location) {
    const others = d.seen_on.filter((s) => !(s.target_id === d.location!.target_id && s.port_name === d.location!.port_name));
    return (
      <div className="space-y-2">
        <LocationView loc={d.location} />
        {others.length > 0 && (
          <p className="text-xs text-faint">
            {tx.alsoSeen}: {others.map((s) => `${s.switch_name} ${s.port_name}`).join(locale === 'ar' ? '، ' : ', ')}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>{d.reason === 'no_switches' ? tx.cardNone : tx.notLocated[d.reason ?? 'not_seen']}</p>
      <Link href="/ports" className="text-accent hover:underline">
        {tx.open}
      </Link>
    </div>
  );
}
