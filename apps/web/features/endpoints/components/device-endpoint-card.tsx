'use client';

import { Cpu } from 'lucide-react';
import Link from 'next/link';
import type { DeviceDetail, DeviceType, EndpointSummary } from '@nigafiy/shared-types';
import { Badge, Card } from '@/components/ui';
import { useApp, useQuery } from '@/lib/app';
import { pct } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { endpointsText } from '../text';

/** Device types the agent cannot run on: no "Enroll" card for them (enrolling stays reachable from Managed computers). */
const NO_AGENT: ReadonlySet<DeviceType> = new Set<DeviceType>(['mobile', 'printer', 'camera', 'media_player', 'iot']);

/** Device page card: the endpoint agent on this device, or how to enroll one. */
export function DeviceEndpointCard({ device }: { device: DeviceDetail }) {
  const { locale } = useI18n();
  const query = useQuery<{ items: EndpointSummary[] }>(`/endpoints?device_id=${device.id}`, ['devices'], 15_000);
  const ep = query.data?.items[0] ?? null;
  // An endpoint that already exists is always shown (it appears once the query answers).
  if (!ep && NO_AGENT.has(device.device_type)) return null;
  return (
    <Card title={endpointsText(locale).deviceCardTitle}>
      <DeviceEndpointCardBody device={device} ep={ep} />
    </Card>
  );
}

function DeviceEndpointCardBody({ device, ep }: { device: DeviceDetail; ep: EndpointSummary | null }) {
  const { locale } = useI18n();
  const tx = endpointsText(locale);
  const { can } = useApp();

  if (ep) {
    const online = ep.status === 'active' && ep.connection_state === 'online';
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-fg">{ep.name}</span>
          <Badge tone={online ? 'ok' : ep.status === 'pending' ? 'warn' : 'crit'}>
            {ep.status === 'pending' ? tx.pending : online ? tx.online : tx.offline}
          </Badge>
        </div>
        {ep.status === 'active' && (
          <div className="grid grid-cols-3 gap-2 rounded-md border border-line bg-bg/60 p-2 text-xs">
            <div>
              <span className="block text-[11px] text-muted">{tx.cpu}</span>
              <span className="mono font-medium text-fg">{pct(ep.cpu_pct, 0)}</span>
            </div>
            <div>
              <span className="block text-[11px] text-muted">{tx.memory}</span>
              <span className="mono font-medium text-fg">{pct(ep.ram_pct, 0)}</span>
            </div>
            <div>
              <span className="block text-[11px] text-muted">{tx.disk}</span>
              <span className="mono font-medium text-fg">{pct(ep.disk_used_pct, 0)}</span>
            </div>
          </div>
        )}
        <p className="text-xs text-muted">{tx.deviceCardEnrolled}</p>
        <Link
          href={`/fleet/endpoints/${ep.id}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-on-accent hover:bg-accent-strong"
        >
          <Cpu className="size-3.5" aria-hidden />
          {tx.deviceCardOpen}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs leading-relaxed text-muted">{tx.deviceCardNone}</p>
      {can('admin') && (
        <Link
          href={`/fleet/endpoints?enroll_device=${encodeURIComponent(device.id)}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 text-xs font-medium text-fg hover:bg-line"
        >
          <Cpu className="size-3.5" aria-hidden />
          {tx.deviceCardEnroll}
        </Link>
      )}
    </div>
  );
}
