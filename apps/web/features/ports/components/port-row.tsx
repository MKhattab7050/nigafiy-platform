'use client';

import type { SwitchPort } from '@lan-detective/shared-types';
import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui';
import { bps } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ROLE_TONE } from './port-tones';
import { PortActionsModal } from './port-actions';
import { PortHistoryChart } from './port-history-chart';
import { controlText } from '../control-text';
import { portsText } from '../text';
import { DeviceLink } from '@/components/device-link';
import { ProtocolBadge } from './neighbors-card';

export function speed(mbps: number): string {
  return mbps >= 1000 ? `${mbps / 1000} Gb/s` : mbps > 0 ? `${mbps} Mb/s` : '';
}

export function PortRow({ p, switchId, admin = false }: { p: SwitchPort; switchId: string; admin?: boolean }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const busiest = Math.max(p.in_bps ?? 0, p.out_bps ?? 0);
  const share = p.speed_mbps > 0 && (p.in_bps !== null || p.out_bps !== null) ? (busiest / (p.speed_mbps * 1e6)) * 100 : null;
  const total = p.in_errors + p.out_errors;
  const rising = (p.errors_delta ?? 0) > 0;
  return (
    <>
    <tr className="align-top">
      <td className="px-4 py-2.5">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? tx.hideHistory : tx.showHistory} className="mono inline-flex items-center gap-1 font-medium hover:text-accent-hover">
          {p.name}
          {open ? <ChevronUp className="size-3.5 text-faint" aria-hidden /> : <ChevronDown className="size-3.5 text-faint" aria-hidden />}
        </button>
        {p.alias && <span className="block text-xs text-muted" dir="auto">{p.alias}</span>}
        {admin && (
          <button type="button" onClick={() => setManaging(true)} className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline">
            <SlidersHorizontal className="size-3" aria-hidden />
            {controlText(locale).manage}
          </button>
        )}
        {managing && <PortActionsModal switchId={switchId} ifIndex={p.if_index} portName={p.name} onClose={() => setManaging(false)} />}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5">
        <Badge tone={p.oper_up ? 'ok' : 'idle'}>{p.oper_up ? tx.up : p.admin_up ? tx.down : tx.disabled}</Badge>
        {p.oper_up && <span className="mt-0.5 block text-xs text-faint tnum">{speed(p.speed_mbps)}</span>}
      </td>
      <td className="px-3 py-2.5">
        {p.role !== 'down' && p.role !== 'edge' && (
          <span className="mb-1 block">
            <Badge tone={ROLE_TONE[p.role]} dot={false}>
              {tx.role[p.role]}
            </Badge>
          </span>
        )}
        {p.neighbors.map((n, i) => (
          <span key={i} className="mb-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <ProtocolBadge protocol={n.protocol} />
            <span dir="auto">
              {tx.neighbor} {n.sys_name ?? n.chassis_id ?? n.address ?? '?'}
            </span>
            {n.port_id && (
              <span className="mono" dir="ltr">
                ({n.port_id})
              </span>
            )}
            {n.platform && (
              <span className="text-faint" dir="auto">
                {n.platform}
              </span>
            )}
          </span>
        ))}
        {p.devices.map((d) => (
          <DeviceLink key={d.mac} id={d.id} className="block truncate hover:text-accent-hover" dir="auto">
            {d.label} <span className="mono text-xs text-muted">{d.ip ?? d.mac}</span>
            {d.vlan > 0 && <span className="text-xs text-faint"> · VLAN {d.vlan}</span>}
          </DeviceLink>
        ))}
        {(p.role === 'trunk' || p.role === 'uplink') && p.mac_count > 0 ? (
          <span className="block text-xs text-faint tnum">
            {p.mac_count} {tx.moreAddr}
          </span>
        ) : (
          p.unknown_addresses.length > 0 && (
            <span className="block text-xs text-faint" title={p.unknown_addresses.join('\n')}>
              <span className="mono">{p.unknown_addresses[0]}</span>
              {p.unknown_addresses.length > 1 && ` +${p.unknown_addresses.length - 1}`} · {tx.unknownAddr}
            </span>
          )
        )}
        {p.role === 'down' && <span className="text-xs text-faint">{tx.nothing}</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-xs">
        {p.in_bps === null && p.out_bps === null ? (
          <span className="text-faint">{p.oper_up ? tx.trafficNone : '—'}</span>
        ) : (
          <>
            <span className="block tnum" dir="ltr">
              ↓ {bps(p.in_bps)} · ↑ {bps(p.out_bps)}
            </span>
            {share !== null && (
              <span className={`block tnum ${share >= 80 ? 'text-warn' : 'text-faint'}`}>
                {share < 1 ? '<1' : Math.round(share)}% {tx.ofSpeed}
              </span>
            )}
          </>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
        {rising ? (
          <span className="text-crit tnum">
            +{p.errors_delta} {tx.newErrors} {Math.max(1, Math.round((p.delta_seconds ?? 60) / 60))} {tx.min}
          </span>
        ) : null}
        <span className="block text-faint tnum">{total > 0 ? `${total} ${tx.total}` : rising ? '' : tx.noErrors}</span>
      </td>
    </tr>
    {open && (
      <tr>
        <td colSpan={5} className="bg-bg/40 px-4 py-3">
          <PortHistoryChart switchId={switchId} ifIndex={p.if_index} />
        </td>
      </tr>
    )}
    </>
  );
}
