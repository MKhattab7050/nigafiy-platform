'use client';

import type { DevicePort } from '@lan-detective/shared-types';
import Link from 'next/link';
import { Card, Spinner } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { DeviceQuarantine } from './device-quarantine';
import { LocationView } from './location-view';
import { portsText } from '../text';

/** Device page card. */
export function DevicePortCard({ deviceId }: { deviceId: string }) {
  const { locale } = useI18n();
  return (
    <Card title={portsText(locale).cardTitle}>
      <DevicePortCardBody deviceId={deviceId} />
    </Card>
  );
}

function DevicePortCardBody({ deviceId }: { deviceId: string }) {
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
        <DeviceQuarantine deviceId={deviceId} />
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>{d.reason === 'no_switches' ? tx.cardNone : tx.notLocated[d.reason ?? 'not_seen']}</p>
      <Link href="/radar/ports" className="text-accent hover:underline">
        {tx.open}
      </Link>
      <DeviceQuarantine deviceId={deviceId} />
    </div>
  );
}
