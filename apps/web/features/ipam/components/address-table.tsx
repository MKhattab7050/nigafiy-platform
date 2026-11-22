'use client';

import type { IpamAddress, IpamSubnetDetail } from '@lan-detective/shared-types';
import { useMemo, useState } from 'react';
import { Badge, Card, Input, Segmented } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { Filter } from '../screens/ipam-screen';
import { STATE_TONE } from './usage-bar';
import { ipamText } from '../text';
import { parseIp } from '../subnet-calc';
import { DeviceLink } from '@/components/device-link';

export function AddressTable({ subnet, onPick }: { subnet: IpamSubnetDetail; onPick: (ip: string) => void }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const [filter, setFilter] = useState<Filter>('all');
  const [text, setText] = useState('');
  const first = parseIp(subnet.first_host)!.value;
  const last = parseIp(subnet.last_host)!.value;

  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const match = (a: IpamAddress) =>
      !needle || [a.ip, a.record?.label, a.record?.mac, a.record?.notes, ...a.devices.flatMap((d) => [d.label, d.mac])].some((v) => v?.toLowerCase().includes(needle));
    return subnet.addresses.filter((a) => {
      const n = parseIp(a.ip)?.value;
      if (n === undefined || n < first || n > last) return false;
      if (filter === 'online' && a.state !== 'online') return false;
      if (filter === 'documented' && !a.record) return false;
      if (filter === 'conflicts' && !a.conflict) return false;
      return match(a);
    });
  }, [subnet.addresses, filter, text, first, last]);

  return (
    <Card
      title={`${tx.addresses} (${rows.length})`}
      padded={false}
      action={
        <Segmented
          label={tx.addresses}
          value={filter}
          onChange={setFilter}
          options={(['all', 'online', 'documented', 'conflicts'] as const).map((f) => ({ value: f, label: tx.filter[f] }))}
        />
      }
    >
      <div className="border-b border-line p-3">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={tx.search} aria-label={tx.search} maxLength={60} className="max-w-sm" />
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">{tx.noRows}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-start text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="px-4 py-2 text-start font-medium">{tx.colAddress}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{tx.colState}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{tx.colDevice}</th>
                <th scope="col" className="px-4 py-2 text-start font-medium">{tx.colRecord}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((a) => {
                const d = a.devices[0];
                return (
                  <tr key={a.ip} className="align-top hover:bg-raised/40">
                    <td className="px-4 py-2.5">
                      <button type="button" onClick={() => onPick(a.ip)} dir="ltr" className="mono break-all text-start font-medium hover:text-accent-hover">
                        {a.ip}
                      </button>
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {a.flags.map((f) => (
                          <span key={f} className="text-[11px] text-faint">
                            {tx.flag[f]}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <Badge tone={a.conflict ? 'crit' : STATE_TONE[a.state]}>{tx.state[a.state]}</Badge>
                      {a.conflict && <span className="mt-1 block text-xs text-crit">{tx.conflictKind[a.conflict]}</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {d ? (
                        <>
                          <DeviceLink id={d.id} className="block truncate hover:text-accent-hover" dir="auto">
                            {d.label}
                          </DeviceLink>
                          <span className="mono text-xs text-muted">{d.mac ?? ''}</span>
                          {a.devices.length > 1 && <span className="text-xs text-faint"> +{a.devices.length - 1}</span>}
                        </>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {a.record ? (
                        <>
                          <span className="block" dir="auto">
                            {a.record.label}
                          </span>
                          <span className="text-xs text-muted">
                            {tx.kind[a.record.kind]}
                            {a.record.mac && <span className="mono"> · {a.record.mac}</span>}
                          </span>
                        </>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
